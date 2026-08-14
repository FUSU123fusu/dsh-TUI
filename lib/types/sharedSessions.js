/**
 * Shared-store bridge (issue #24): dsh web and the dsh CLI persist sessions to
 * the SHARED JSONL store at `$DSH_HOME/sessions/<cwd-slug>/<session-id>/session.jsonl[.zstd]`,
 * while cc-tui keeps its own SQLite store (`~/.dsh-cc/sessions.sqlite`) so one
 * write path owns every session. `/resume` lists only the SQLite store, so
 * sessions created by dsh web never appeared in the picker and could not be
 * resumed. This module reads the shared store directly:
 *
 * - {@link listSharedSessions} scans the store and decodes each log's FIRST
 *   zstd frame (the header line carries id/cwd/createdAt — no full-log read),
 *   picking up titles from `$DSH_HOME/storages/session_projcache.json`.
 * - {@link importSharedSession} fully decodes one log so the caller can
 *   materialize it into the SQLite store (`appendBatch`) and resume it
 *   through the normal persistence seam.
 *
 * The zstd container is a concatenation of independent frames (one per
 * durable append batch, checksummed); a frame-boundary scan finds each frame
 * without decompressing the whole file, matching dsh-session-persistence-jsonl.
 */
import { constants, zstdDecompressSync } from 'node:zlib';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodeStorageRecord, SessionId } from '@deepseek-ai/dsh-session';
/** Zstandard frame magic (little-endian 0xFD2FB528). */
const ZSTD_MAGIC = 0xfd2fb528;
/** Read window for header-only decodes; chunks append until the first frame completes. */
const HEADER_READ_CHUNK = 64 * 1024;
/**
 * Read the smallest prefix of a zstd artifact containing one complete frame
 * (the header frame is a few hundred bytes; long logs never load in full
 * just to list their header).
 * @param file - Absolute path of the `.jsonl.zstd` artifact.
 * @returns The first frame's byte range within the file.
 */
function readFirstFrame(file) {
    const fd = openSync(file, 'r');
    try {
        let buffer = Buffer.alloc(0);
        for (;;) {
            const chunk = Buffer.allocUnsafe(HEADER_READ_CHUNK);
            const read = readSync(fd, chunk, 0, chunk.length, buffer.length);
            if (read === 0)
                break;
            buffer = Buffer.concat([buffer, chunk.subarray(0, read)]);
            const { frames } = scanZstdFrames(buffer, 1);
            if (frames.length === 1)
                return buffer.subarray(frames[0].start, frames[0].end);
        }
        const { frames } = scanZstdFrames(buffer, 1);
        if (frames.length === 0)
            throw new Error('no complete zstd frame');
        return buffer.subarray(frames[0].start, frames[0].end);
    }
    finally {
        closeSync(fd);
    }
}
/**
 * The DSH home directory (`dshHomePath()` in loader `!!js` expressions):
 * `$DSH_HOME` with `~` expansion, else `~/.dsh`.
 * @returns The absolute DSH home path.
 */
export function dshHome() {
    const configured = process.env.DSH_HOME;
    if (configured !== undefined && configured !== '') {
        if (configured === '~')
            return homedir();
        if (configured.startsWith('~/') || configured.startsWith('~\\')) {
            return join(homedir(), configured.slice(2));
        }
        return configured;
    }
    return join(homedir(), '.dsh');
}
/**
 * cwd comparison for the `/resume` project filter: trailing separators of
 * either style are stripped, and on Windows the comparison is
 * case-insensitive (drive-letter case differs between frontends).
 * @param a - First path.
 * @param b - Second path.
 * @returns True when both paths name the same directory.
 */
export function sameCwd(a, b) {
    const normalize = (value) => {
        // POSIX paths may legitimately END in '\' — only Windows treats both
        // separator spellings and case as equivalent.
        if (process.platform === 'win32')
            return value.replace(/[\\/]+$/, '').toLowerCase();
        return value.replace(/\/+$/, '');
    };
    return normalize(a) === normalize(b);
}
/**
 * Locate complete zstd frames without decompressing their blocks (ported
 * from dsh-session-persistence-jsonl's scanner). A structurally incomplete
 * final frame is reported as `tornStart` instead of throwing.
 * @param buffer - Bytes currently present in the session artifact.
 * @param maxFrames - Optional complete-frame limit (header-only readers pass 1).
 * @returns Complete frame ranges and an optional incomplete-final-frame start.
 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
    const frames = [];
    let offset = 0;
    while (offset < buffer.length) {
        const start = offset;
        if (buffer.length - offset < 4)
            return { frames, tornStart: start };
        if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
            throw new Error(`corrupt zstd session log: invalid frame magic at byte ${offset}`);
        }
        offset += 4;
        if (offset === buffer.length)
            return { frames, tornStart: start };
        const descriptor = buffer.readUInt8(offset);
        offset += 1;
        if ((descriptor & 24) !== 0) {
            throw new Error(`corrupt zstd session log: reserved frame-header bit at byte ${offset - 1}`);
        }
        const contentSizeFlag = descriptor >>> 6;
        const singleSegment = (descriptor & 32) !== 0;
        const checksum = (descriptor & 4) !== 0;
        const dictionaryFlag = descriptor & 3;
        const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
        const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
        const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
        if (buffer.length - offset < remainingHeaderBytes)
            return { frames, tornStart: start };
        offset += remainingHeaderBytes;
        for (;;) {
            if (buffer.length - offset < 3)
                return { frames, tornStart: start };
            const blockHeader = buffer.readUIntLE(offset, 3);
            offset += 3;
            const lastBlock = (blockHeader & 1) !== 0;
            const blockType = (blockHeader >>> 1) & 3;
            const blockSize = blockHeader >>> 3;
            if (blockType === 3) {
                throw new Error(`corrupt zstd session log: reserved block type at byte ${offset - 3}`);
            }
            const payloadBytes = blockType === 1 ? 1 : blockSize;
            if (buffer.length - offset < payloadBytes)
                return { frames, tornStart: start };
            offset += payloadBytes;
            if (lastBlock)
                break;
        }
        if (checksum) {
            if (buffer.length - offset < 4)
                return { frames, tornStart: start };
            offset += 4;
        }
        frames.push({ start, end: offset });
        if (frames.length === maxFrames)
            return { frames };
    }
    return { frames };
}
/**
 * Decode a session artifact to JSONL text. `.jsonl` files pass through;
 * `.jsonl.zstd` files are decoded frame by frame (one-shot decoding stops at
 * the first frame). A torn final frame (crash mid-append) is salvaged
 * best-effort via `ZSTD_e_flush`, else dropped — the persisted prefix stays
 * resumable.
 * @param file - Absolute path of the session artifact.
 * @param firstFrameOnly - Decode only the first frame (the header line).
 * @returns The decoded JSONL text.
 */
function decodeSessionFile(file, firstFrameOnly) {
    if (!file.endsWith('.zstd'))
        return readFileSync(file, 'utf8');
    if (firstFrameOnly)
        return zstdDecompressSync(readFirstFrame(file)).toString('utf8');
    const buffer = readFileSync(file);
    const { frames, tornStart } = scanZstdFrames(buffer);
    const parts = [];
    for (const frame of frames) {
        parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'));
    }
    if (!firstFrameOnly && tornStart !== undefined) {
        try {
            parts.push(zstdDecompressSync(buffer.subarray(tornStart), {
                finishFlush: constants.ZSTD_e_flush,
            }).toString('utf8'));
        }
        catch {
            // Torn tail unsalvageable — the complete frames already decode.
        }
    }
    return parts.join('');
}
/**
 * Read a session artifact's header line (first frame only for zstd).
 * @param file - Absolute path of the session artifact.
 * @returns The parsed header, or undefined when absent/malformed.
 */
function readHeader(file) {
    const text = decodeSessionFile(file, true);
    const newline = text.indexOf('\n');
    const line = newline === -1 ? text : text.slice(0, newline);
    const parsed = JSON.parse(line);
    if (parsed.type !== 'session' || typeof parsed.id !== 'string')
        return undefined;
    const { type: _type, ...meta } = parsed;
    return meta;
}
/**
 * dsh web's session titles from the projection cache
 * (`storages/session_projcache.json`, session id → title). Best effort.
 * @returns The parsed title map; an unreadable cache yields {}.
 */
function readSharedTitles() {
    try {
        const parsed = JSON.parse(readFileSync(join(dshHome(), 'storages', 'session_projcache.json'), 'utf8'));
        const sessions = parsed?.tables?.sessions;
        if (sessions === null || typeof sessions !== 'object')
            return {};
        const titles = {};
        for (const [id, entry] of Object.entries(sessions)) {
            const val = entry?.rows?.title?.val;
            if (typeof val === 'string' && val.length > 0)
                titles[id] = val;
        }
        return titles;
    }
    catch {
        return {};
    }
}
/**
 * The session artifact inside a shared-store session directory, if any.
 * @param dir - Absolute path of the `session-*` directory.
 * @returns The artifact's absolute path, preferring the zstd variant.
 */
function sessionArtifact(dir) {
    for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
        const file = join(dir, name);
        if (existsSync(file))
            return file;
    }
    return undefined;
}
/**
 * List every session in the shared JSONL store (`$DSH_HOME/sessions`). Each
 * log's first frame supplies the header; corrupt or unreadable entries are
 * skipped so one bad session never breaks `/resume`.
 * @returns Shared-store sessions with titles from the projection cache.
 */
export function listSharedSessions() {
    const root = join(dshHome(), 'sessions');
    let slugs;
    try {
        slugs = readdirSync(root);
    }
    catch {
        return [];
    }
    const titles = readSharedTitles();
    const entries = [];
    for (const slug of slugs) {
        let sessionDirs;
        try {
            sessionDirs = readdirSync(join(root, slug));
        }
        catch {
            continue;
        }
        for (const sessionDir of sessionDirs) {
            if (!sessionDir.startsWith('session-'))
                continue;
            const dir = join(root, slug, sessionDir);
            const file = sessionArtifact(dir);
            if (file === undefined)
                continue;
            try {
                const header = readHeader(file);
                if (header === undefined)
                    continue;
                entries.push({
                    id: sessionDir,
                    cwd: header.cwd ?? '',
                    createdAt: header.createdAt,
                    updatedAt: statSync(file).mtimeMs,
                    ...(titles[sessionDir] === undefined ? {} : { title: titles[sessionDir] }),
                });
            }
            catch {
                // Skip corrupt/unreadable logs; the picker degrades per session.
            }
        }
    }
    return entries;
}
/**
 * Fully decode one shared-store session for import into cc-tui's SQLite
 * store. Events keep their original seqs and envelope fields (`surfaceOp`,
 * `sourceEventSeqs`, `ignorable`), so `appendBatch(meta, events, false)`
 * materializes the log verbatim.
 * @param sessionId - The session id (also its directory name in the store).
 * @returns The decoded log, or undefined when the id is absent or unreadable.
 */
export function importSharedSession(sessionId) {
    const root = join(dshHome(), 'sessions');
    let slugs;
    try {
        slugs = readdirSync(root);
    }
    catch {
        return undefined;
    }
    for (const slug of slugs) {
        const file = sessionArtifact(join(root, slug, sessionId));
        if (file === undefined)
            continue;
        try {
            const text = decodeSessionFile(file, false);
            const lines = text.split('\n').filter(line => line.length > 0);
            const [headerLine, ...eventLines] = lines;
            if (headerLine === undefined)
                return undefined;
            const header = JSON.parse(headerLine);
            if (header.type !== 'session' || typeof header.id !== 'string')
                return undefined;
            const { type: _type, ...meta } = header;
            // JSONL logs store runs of stream deltas as packed storage rows
            // (`reasoning-chunks`/`text-chunks`/`tool-call-chunks`, seq0-enveloped);
            // the SQLite events table keys one row per event seq, so packed rows
            // expand back to the exact original events on import.
            const events = eventLines.flatMap(line => decodeStorageRecord(JSON.parse(line)));
            return { meta: meta, events };
        }
        catch {
            return undefined;
        }
    }
    return undefined;
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
export async function ensureSharedSessionImported(persistence, sessionId) {
    if (persistence?.loadStored === undefined || persistence.appendBatch === undefined) {
        return 'missing';
    }
    const id = SessionId(sessionId);
    try {
        if ((await persistence.loadStored(id)) !== undefined)
            return 'local';
    }
    catch {
        // Unknown to the local store — fall through to the import attempt.
    }
    const log = importSharedSession(sessionId);
    if (log === undefined)
        return 'missing';
    try {
        await persistence.appendBatch(log.meta, log.events, false);
        return 'imported';
    }
    catch {
        return 'missing';
    }
}
