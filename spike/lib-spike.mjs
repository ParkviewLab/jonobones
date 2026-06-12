// M0 derive spike: prove @joplin/lib can run headless outside the Joplin apps.
//
// Two independent processes (one per profile — same isolation model as the
// future daemon) exchange a note through a filesystem sync target:
//
//   node spike/lib-spike.mjs run            ← orchestrator (temp dirs, spawns the two below)
//   node spike/lib-spike.mjs seed   --profile <dir> --sync-dir <dir>
//   node spike/lib-spike.mjs verify --profile <dir> --sync-dir <dir> --folder-id <id> --note-id <id>
//
// Bootstrap sequence cribbed from @joplin/lib/testing/test-utils.ts and
// jest.setup.js (the lib's own minimal headless boot), adapted to a fresh
// production-like profile dir instead of the jest fixture layout.
//
// Notable findings encoded here (matter for the real daemon later):
// - shimInit must receive nodeSqlite (the `sqlite3` npm module): the DB driver
//   resolves it via shim.nodeSqlite(), not by requiring it itself.
// - shim.appVersion() feeds the sync-target compatibility check
//   (checkIfCanSync), so it must report the embedded @joplin/lib version,
//   NOT the product's own version number.
// - All of Logger/Resource/EncryptionService/FileApiDriverLocal need the
//   FsDriverNode injected as statics before anything touches the filesystem.

import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const req = createRequire(import.meta.url);
const selfPath = fileURLToPath(import.meta.url);

const FOLDER_TITLE = 'jonobones spike notebook';
const NOTE_TITLE = 'jonobones spike note';
const NOTE_BODY = 'Round-trip me, please. Unicode check: déjà vu, 草書, 🦴.\n\nSecond paragraph.';
const RESULT_PREFIX = 'SPIKE_RESULT:';

const arg = (name) => {
	const i = process.argv.indexOf(name);
	return i === -1 ? null : process.argv[i + 1];
};

const emitResult = (obj) => {
	process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(obj)}\n`);
};

// ---------------------------------------------------------------------------
// Headless @joplin/lib bootstrap for one profile dir
// ---------------------------------------------------------------------------

async function bootstrap(profileDir, syncDir) {
	const { shimInit } = req('@joplin/lib/shim-init-node.js');
	const sqlite3 = req('sqlite3');
	const libVersion = req('@joplin/lib/package.json').version;

	// appVersion: the sync-format compatibility handshake must see the engine
	// (lib) version, not the jonobones product version.
	shimInit({ nodeSqlite: sqlite3, appVersion: () => libVersion });

	const LoggerModule = req('@joplin/utils/Logger');
	const Logger = LoggerModule.default;
	const { TargetType } = LoggerModule;
	const initLib = req('@joplin/lib/initLib.js').default;
	const FsDriverNode = req('@joplin/lib/fs-driver-node.js').default;
	const SettingModule = req('@joplin/lib/models/Setting.js');
	const Setting = SettingModule.default;
	const { AppType, Env } = SettingModule;
	const BaseModel = req('@joplin/lib/BaseModel.js').default;
	const BaseItem = req('@joplin/lib/models/BaseItem.js').default;
	const Note = req('@joplin/lib/models/Note.js').default;
	const Folder = req('@joplin/lib/models/Folder.js').default;
	const Resource = req('@joplin/lib/models/Resource.js').default;
	const Tag = req('@joplin/lib/models/Tag.js').default;
	const NoteTag = req('@joplin/lib/models/NoteTag.js').default;
	const MasterKey = req('@joplin/lib/models/MasterKey.js').default;
	const Revision = req('@joplin/lib/models/Revision.js').default;
	const ItemChange = req('@joplin/lib/models/ItemChange.js').default;
	const JoplinDatabase = req('@joplin/lib/JoplinDatabase.js').default;
	const { DatabaseDriverNode } = req('@joplin/lib/database-driver-node.js');
	const SyncTargetRegistry = req('@joplin/lib/SyncTargetRegistry.js').default;
	const SyncTargetFilesystem = req('@joplin/lib/SyncTargetFilesystem.js').default;
	const FileApiDriverLocal = req('@joplin/lib/file-api-driver-local.js').default;
	const { reg } = req('@joplin/lib/registry.js');
	const BaseService = req('@joplin/lib/services/BaseService.js').default;
	const EncryptionService = req('@joplin/lib/services/e2ee/EncryptionService.js').default;
	const RevisionService = req('@joplin/lib/services/RevisionService.js').default;
	const DecryptionWorker = req('@joplin/lib/services/DecryptionWorker.js').default;
	const KvStore = req('@joplin/lib/services/KvStore.js').default;
	const { loadKeychainServiceAndSettings } = req('@joplin/lib/services/SettingUtils.js');
	const KeychainServiceDriverDummy = req('@joplin/lib/services/keychain/KeychainServiceDriver.dummy.js').default;
	const { setRSA } = req('@joplin/lib/services/e2ee/ppk/ppk.js');
	const RSA = req('@joplin/lib/services/e2ee/ppk/RSA.node.js').default;

	const logger = new Logger();
	logger.addTarget(TargetType.Console);
	logger.setLevel(Logger.LEVEL_WARN);
	Logger.initializeGlobalLogger(logger);
	initLib(logger);

	const fsDriver = new FsDriverNode();
	Logger.fsDriver_ = fsDriver;
	Resource.fsDriver_ = fsDriver;
	EncryptionService.fsDriver_ = fsDriver;
	FileApiDriverLocal.fsDriver_ = fsDriver;
	BaseService.logger_ = logger;

	BaseItem.loadClass('Note', Note);
	BaseItem.loadClass('Folder', Folder);
	BaseItem.loadClass('Resource', Resource);
	BaseItem.loadClass('Tag', Tag);
	BaseItem.loadClass('NoteTag', NoteTag);
	BaseItem.loadClass('MasterKey', MasterKey);
	BaseItem.loadClass('Revision', Revision);

	const resourceDir = join(profileDir, 'resources');
	const tempDir = join(profileDir, 'tmp');
	const cacheDir = join(profileDir, 'cache');
	for (const d of [profileDir, resourceDir, tempDir, cacheDir]) mkdirSync(d, { recursive: true });

	Setting.autoSaveEnabled = false;
	Setting.setConstant('appId', 'org.parkviewlab.jonobones-spike');
	Setting.setConstant('appType', AppType.Cli);
	Setting.setConstant('env', Env.Prod);
	Setting.setConstant('profileDir', profileDir);
	Setting.setConstant('rootProfileDir', profileDir);
	Setting.setConstant('resourceDirName', 'resources');
	Setting.setConstant('resourceDir', resourceDir);
	Setting.setConstant('tempDir', tempDir);
	Setting.setConstant('cacheDir', cacheDir);
	Setting.setConstant('pluginDataDir', join(profileDir, 'plugin-data'));
	Setting.setConstant('pluginDir', join(profileDir, 'plugins'));
	Setting.setConstant('isSubProfile', false);

	SyncTargetRegistry.addClass(SyncTargetFilesystem);

	const dbLogger = new Logger();
	dbLogger.addTarget(TargetType.Console);
	dbLogger.setLevel(Logger.LEVEL_WARN);

	const db = new JoplinDatabase(new DatabaseDriverNode());
	db.setLogger(dbLogger);
	await db.open({ name: join(profileDir, 'database.sqlite') });
	BaseModel.setDb(db);
	reg.setDb(db);

	await loadKeychainServiceAndSettings([KeychainServiceDriverDummy]);

	Setting.setValue('sync.target', SyncTargetFilesystem.id());
	Setting.setValue('sync.2.path', syncDir);

	const encryptionService = new EncryptionService();
	BaseItem.encryptionService_ = encryptionService;
	Resource.encryptionService_ = encryptionService;
	const revisionService = new RevisionService();
	BaseItem.revisionService_ = revisionService;
	const decryptionWorker = new DecryptionWorker();
	decryptionWorker.setEncryptionService(encryptionService);
	DecryptionWorker.instance_ = decryptionWorker;
	KvStore.instance().setDb(db);
	setRSA(RSA);

	const syncTarget = new SyncTargetFilesystem(db);
	syncTarget.setLogger(logger);
	const synchronizer = await syncTarget.synchronizer();
	synchronizer.setShareService(null);

	const sync = async () => {
		const contextKey = `sync.${SyncTargetFilesystem.id()}.context`;
		const contextString = Setting.value(contextKey);
		const context = contextString ? JSON.parse(contextString) : {};
		const newContext = await synchronizer.start({ context, throwOnError: true });
		Setting.setValue(contextKey, JSON.stringify(newContext));
	};

	const shutdown = async () => {
		await ItemChange.waitForAllSaved();
		await Setting.saveAll();
		await db.close();
	};

	return { Folder, Note, sync, shutdown };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function seed() {
	const { Folder, Note, sync, shutdown } = await bootstrap(arg('--profile'), arg('--sync-dir'));
	const folder = await Folder.save({ title: FOLDER_TITLE });
	const note = await Note.save({ title: NOTE_TITLE, body: NOTE_BODY, parent_id: folder.id });
	await sync();
	await shutdown();
	emitResult({ folderId: folder.id, noteId: note.id });
}

async function verify() {
	const expectedFolderId = arg('--folder-id');
	const expectedNoteId = arg('--note-id');
	const { Folder, Note, sync, shutdown } = await bootstrap(arg('--profile'), arg('--sync-dir'));
	await sync();

	const folder = await Folder.load(expectedFolderId);
	const note = await Note.load(expectedNoteId);
	const problems = [];
	if (!folder) problems.push('folder did not arrive');
	else if (folder.title !== FOLDER_TITLE) problems.push(`folder title mismatch: ${JSON.stringify(folder.title)}`);
	if (!note) problems.push('note did not arrive');
	else {
		if (note.title !== NOTE_TITLE) problems.push(`note title mismatch: ${JSON.stringify(note.title)}`);
		if (note.body !== NOTE_BODY) problems.push(`note body mismatch: ${JSON.stringify(note.body)}`);
		if (note.parent_id !== expectedFolderId) problems.push(`note parent mismatch: ${note.parent_id}`);
	}

	await shutdown();
	emitResult({ ok: problems.length === 0, problems });
	if (problems.length) process.exitCode = 1;
}

function runChild(args) {
	const res = spawnSync(process.execPath, [selfPath, ...args], { encoding: 'utf8' });
	const resultLine = (res.stdout || '').split('\n').find((l) => l.startsWith(RESULT_PREFIX));
	return {
		status: res.status,
		result: resultLine ? JSON.parse(resultLine.slice(RESULT_PREFIX.length)) : null,
		stdout: res.stdout,
		stderr: res.stderr,
	};
}

async function run() {
	const base = mkdtempSync(join(tmpdir(), 'jonobones-spike-'));
	const profileA = join(base, 'profile-a');
	const profileB = join(base, 'profile-b');
	const syncDir = join(base, 'sync-target');

	console.log(`spike workspace: ${base}`);

	const seedRes = runChild(['seed', '--profile', profileA, '--sync-dir', syncDir]);
	if (seedRes.status !== 0 || !seedRes.result) {
		console.error('SEED FAILED');
		console.error(seedRes.stdout);
		console.error(seedRes.stderr);
		process.exit(2);
	}
	console.log(`seeded from profile A: folder=${seedRes.result.folderId} note=${seedRes.result.noteId}`);

	// Filesystem targets have second-granularity timestamps; give the target a
	// moment so profile B's delta logic can't race (same reason test-utils
	// sleeps 1001ms when switching clients on the filesystem target).
	await new Promise((r) => setTimeout(r, 1100));

	const verifyRes = runChild([
		'verify',
		'--profile', profileB,
		'--sync-dir', syncDir,
		'--folder-id', seedRes.result.folderId,
		'--note-id', seedRes.result.noteId,
	]);
	if (verifyRes.status !== 0 || !verifyRes.result || !verifyRes.result.ok) {
		console.error('VERIFY FAILED');
		console.error(verifyRes.stdout);
		console.error(verifyRes.stderr);
		console.error(`workspace kept for inspection: ${base}`);
		process.exit(1);
	}

	console.log('PASS: profile B received the notebook and note intact through the filesystem sync target.');
	rmSync(base, { recursive: true, force: true });
}

const mode = process.argv[2];
const modes = { run, seed, verify };
if (!modes[mode]) {
	console.error('usage: lib-spike.mjs run | seed --profile <dir> --sync-dir <dir> | verify --profile <dir> --sync-dir <dir> --folder-id <id> --note-id <id>');
	process.exit(2);
}
modes[mode]().catch((error) => {
	console.error(error);
	process.exit(2);
});
