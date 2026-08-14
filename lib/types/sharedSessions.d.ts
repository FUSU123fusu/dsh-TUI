import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
/** One session found in the shared JSONL store, as the `/resume` picker lists it. */
export interface SharedSessionEntry {
    id: string;
    cwd: string;
    createdAt: number;
    /** Log file mtime — the shared store's best "last activity" signal. */
    updatedAt: number;
    /** dsh web's own title from the projection cache, when present. */
    title?: string;
}
/** A fully decoded shared-store session, ready for `appendBatch` import. */
export interface SharedSessionLog {
    meta: SessionHeader;
    events: SessionEvent[];
}
/**
 * The DSH home directory (`dshHomePath()` in loader `!!js` expressions):
 * `$DSH_HOME` with `~` expansion, else `~/.dsh`.
 * @returns The absolute DSH home path.
 */
export declare function dshHome(): string;
/**
 * cwd comparison for the `/resume` project filter: trailing separators of
 * either style are stripped, and on Windows the comparison is
 * case-insensitive (drive-letter case differs between frontends).
 * @param a - First path.
 * @param b - Second path.
 * @returns True when both paths name the same directory.
 */
export declare function sameCwd(a: string, b: string): boolean;
/**
 * List every session in the shared JSONL store (`$DSH_HOME/sessions`). Each
 * log's first frame supplies the header; corrupt or unreadable entries are
 * skipped so one bad session never breaks `/resume`.
 * @returns Shared-store sessions with titles from the projection cache.
 */
export declare function listSharedSessions(): SharedSessionEntry[];
/**
 * Fully decode one shared-store session for import into cc-tui's SQLite
 * store. Events keep their original seqs and envelope fields (`surfaceOp`,
 * `sourceEventSeqs`, `ignorable`), so `appendBatch(meta, events, false)`
 * materializes the log verbatim.
 * @param sessionId - The session id (also its directory name in the store).
 * @returns The decoded log, or undefined when the id is absent or unreadable.
 */
export declare function importSharedSession(sessionId: string): SharedSessionLog | undefined;
/**
 * The structural slice of the SQLite session-persistence backend the import
 * path needs. Both methods exist on dsh-session-persistence-sqlite; when a
 * different backend is mounted the import degrades to "not imported".
 */
export interface ImportablePersistence {
    loadStored?(id: SessionId): Promise<unknown | undefined>;
    appendBatch?(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<unknown>;
}
/**
 * Materialize a shared-store (dsh web / dsh CLI) session into cc-tui's own
 * persistence store so the normal resume seam can load it (issue #24).
 * No-op when the session is already stored locally, absent from the shared
 * store, or the mounted backend is not the SQLite one.
 * @param persistence - The mounted `sessionPersistence` service.
 * @param sessionId - The session to import.
 * @returns 'local' when the session was already in the local store,
 *   'imported' when this call materialized it, 'missing' otherwise.
 */
export declare function ensureSharedSessionImported(persistence: ImportablePersistence | undefined, sessionId: string): Promise<'local' | 'imported' | 'missing'>;
//# sourceMappingURL=sharedSessions.d.ts.map