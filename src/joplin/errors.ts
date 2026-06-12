// Domain errors thrown by the anti-corruption layer. The API layer maps
// them onto HTTP statuses; the ACL itself knows nothing about HTTP.

export class ItemNotFoundError extends Error {
  public constructor(kind: string, id: string) {
    super(`no such ${kind}: ${id}`);
  }
}

export class ItemConflictError extends Error {}

export class ItemValidationError extends Error {}
