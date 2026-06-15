// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Interactive prompts over a line queue we own. readline/promises drops
// type-ahead lines that arrive while no question is pending (they fire as
// unlistened 'line' events), which breaks scripted use like
// `printf "1\n/path\n" | jonobones init`. A plain data-listener queue keeps
// every line; a TTY still cooks echo/editing in the terminal driver.

export class StdinEndedError extends Error {
  public constructor() {
    super('stdin ended before the prompt was answered');
  }
}

export class Prompter {
  private buffered: string[] = [];
  private partial = '';
  private waiters: { resolve: (line: string) => void; reject: (error: Error) => void }[] = [];
  private ended = false;
  private readonly onData: (chunk: Buffer) => void;
  private readonly onEnd: () => void;

  public constructor() {
    this.onData = (chunk: Buffer) => this.feed(chunk.toString('utf8'));
    this.onEnd = () => {
      this.ended = true;
      while (this.waiters.length) this.waiters.shift()!.reject(new StdinEndedError());
    };
    process.stdin.on('data', this.onData);
    process.stdin.on('end', this.onEnd);
  }

  private feed(text: string): void {
    this.partial += text;
    for (;;) {
      const newline = this.partial.indexOf('\n');
      if (newline === -1) break;
      const line = this.partial.slice(0, newline).replace(/\r$/, '');
      this.partial = this.partial.slice(newline + 1);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.buffered.push(line);
    }
  }

  private nextLine(): Promise<string> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.ended) return Promise.reject(new StdinEndedError());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private async question(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    return this.nextLine();
  }

  public async ask(question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue !== undefined && defaultValue !== '' ? ` [${defaultValue}]` : '';
    const answer = (await this.question(`${question}${suffix}: `)).trim();
    return answer === '' && defaultValue !== undefined ? defaultValue : answer;
  }

  public async askRequired(question: string, defaultValue?: string): Promise<string> {
    for (;;) {
      const answer = await this.ask(question, defaultValue);
      if (answer !== '') return answer;
      console.log('  a value is required.');
    }
  }

  /** Read without echo on a TTY; falls back to a plain line read when piped. */
  public async askHidden(question: string): Promise<string> {
    const { stdin } = process;
    if (!stdin.isTTY) return this.question(`${question}: `);

    process.stdout.write(`${question}: `);
    // Suspend the line queue so password chars don't land in it as well.
    stdin.off('data', this.onData);
    stdin.setRawMode(true);
    try {
      let value = '';
      for (;;) {
        const chunk = await new Promise<string>((resolve, reject) => {
          const onData = (data: Buffer) => {
            cleanup();
            resolve(data.toString('utf8'));
          };
          const onEnd = () => {
            cleanup();
            reject(new StdinEndedError());
          };
          const cleanup = () => {
            stdin.off('data', onData);
            stdin.off('end', onEnd);
          };
          // Raw mode bypasses our queue listener (it still fires, but we
          // consume the same chunks here first come, first served).
          stdin.once('data', onData);
          stdin.once('end', onEnd);
        });
        for (const char of chunk) {
          if (char === '\u0003') throw new StdinEndedError(); // ctrl-c
          if (char === '\r' || char === '\n') {
            process.stdout.write('\n');
            return value;
          }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
          else value += char;
        }
      }
    } finally {
      stdin.setRawMode(false);
      stdin.on('data', this.onData);
    }
  }

  public async confirm(question: string, defaultYes = false): Promise<boolean> {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = (await this.question(`${question} [${hint}]: `)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  }

  public async choose<T extends { key: string; label: string }>(question: string, options: T[]): Promise<T> {
    console.log(`${question}`);
    options.forEach((option, i) => console.log(`  ${i + 1}. ${option.label}`));
    for (;;) {
      const answer = (await this.question(`choice [1-${options.length}]: `)).trim();
      const index = parseInt(answer, 10) - 1;
      if (!Number.isNaN(index) && index >= 0 && index < options.length) return options[index]!;
      console.log('  please enter a number from the list.');
    }
  }

  public close(): void {
    process.stdin.off('data', this.onData);
    process.stdin.off('end', this.onEnd);
    process.stdin.pause();
  }
}
