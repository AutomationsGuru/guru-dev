/**
 * InternalUriSchemeRouter
 *
 * Parser-only router for GuruHarness internal URI schemes.
 * Supports known schemes; unknown schemes fail closed.
 * No network, filesystem, GitHub, agent, skill, credential, or external resolution.
 * Strictly parsing and validation of syntax and known scheme rules.
 *
 * @module src/tools/internalUriSchemeRouter
 */

export type InternalUriScheme =
  | 'guru'
  | 'idea'
  | 'handoff'
  | 'loop'
  | 'review'
  | 'skill'
  | 'agent'
  | 'task'
  | 'memory'
  | 'doc'
  | 'prompt'
  | 'config'
  | 'secret'
  | 'env'
  | 'file';

const KNOWN_SCHEMES: Set<InternalUriScheme> = new Set([
  'guru', 'idea', 'handoff', 'loop', 'review', 'skill',
  'agent', 'task', 'memory', 'doc', 'prompt', 'config',
  'secret', 'env', 'file'
]);

export interface ParsedInternalUri {
  /** The scheme (always lowercased, known) */
  scheme: InternalUriScheme;
  /** Authority component (e.g. 'session' for guru://session/...) or undefined */
  authority?: string;
  /** Pathname, always starts with / (normalized) */
  path: string;
  /** Parsed query params as key-value record */
  query: Record<string, string>;
  /** Fragment without leading # */
  fragment?: string;
  /** Original raw input (trimmed) */
  raw: string;
}

export class UnknownInternalSchemeError extends Error {
  constructor(public readonly scheme: string) {
    super(`Unknown internal scheme: ${scheme}. Only known GuruHarness schemes are allowed.`);
    this.name = 'UnknownInternalSchemeError';
  }
}

export class InvalidInternalUriError extends Error {
  constructor(message: string, public readonly raw?: string) {
    super(message);
    this.name = 'InvalidInternalUriError';
  }
}

/**
 * InternalUriSchemeRouter
 *
 * The single source of truth for parsing internal URIs in GuruHarness.
 * Parser only - does not perform resolution, I/O, network, or external lookups.
 * Unknown schemes and malformed inputs fail closed.
 */
export class InternalUriSchemeRouter {
  /**
   * Parse and validate an internal URI string.
   * Returns structured ParsedInternalUri on success.
   * Throws UnknownInternalSchemeError for unknown schemes (fail closed).
   * Throws InvalidInternalUriError for syntax errors or scheme-specific rule violations.
   */
  parse(raw: string): ParsedInternalUri {
    if (!raw || typeof raw !== 'string') {
      throw new InvalidInternalUriError('URI must be a non-empty string');
    }

    const trimmed = raw.trim();
    if (!trimmed.includes('://')) {
      throw new InvalidInternalUriError('Internal URI must contain "://"', trimmed);
    }

    // Extract and validate scheme (case-insensitive input, lowercased in result)
    const schemePart = trimmed.split('://')[0].toLowerCase();
    if (!KNOWN_SCHEMES.has(schemePart as InternalUriScheme)) {
      throw new UnknownInternalSchemeError(schemePart);
    }
    const scheme = schemePart as InternalUriScheme;

    // Use Node built-in URL parser (supports custom schemes in Node 24+)
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch (err) {
      throw new InvalidInternalUriError(
        `Malformed internal URI: ${(err as Error).message}`,
        trimmed
      );
    }

    // Parser-time security hygiene: reject obvious path traversal
    // (full enforcement happens in resolution layer; parser fails closed on ..)
    if (url.pathname.includes('../') || url.pathname.includes('..\\')) {
      throw new InvalidInternalUriError(
        'Path traversal sequences are not permitted in internal URIs',
        trimmed
      );
    }

    // Build normalized result
    const parsed: ParsedInternalUri = {
      scheme,
      authority: url.hostname || undefined,
      path: url.pathname || '/',
      query: Object.fromEntries(url.searchParams.entries()),
      fragment: url.hash ? url.hash.slice(1) : undefined,
      raw: trimmed,
    };

    // Scheme-specific validation and rules
    this.validateScheme(scheme, parsed);

    return parsed;
  }

  private validateScheme(scheme: InternalUriScheme, parsed: ParsedInternalUri): void {
    switch (scheme) {
      case 'guru':
        if (!parsed.authority || !['session', 'thread'].includes(parsed.authority)) {
          throw new InvalidInternalUriError(
            'guru:// requires authority "session" or "thread" (e.g. guru://session/<id>)',
            parsed.raw
          );
        }
        if (!parsed.path || parsed.path === '/') {
          throw new InvalidInternalUriError('guru:// requires a target ID in path', parsed.raw);
        }
        break;

      case 'idea':
        if (parsed.authority) {
          throw new InvalidInternalUriError('idea:// must not have authority component (use idea://<slug>)', parsed.raw);
        }
        if (!parsed.path || parsed.path === '/') {
          throw new InvalidInternalUriError('idea:// requires a slug in path', parsed.raw);
        }
        break;

      case 'file':
        if (parsed.authority) {
          throw new InvalidInternalUriError('file:// must use triple-slash form (file:///absolute/path)', parsed.raw);
        }
        if (!parsed.path || parsed.path === '/') {
          throw new InvalidInternalUriError('file:// requires absolute path', parsed.raw);
        }
        break;

      case 'env':
      case 'secret':
        if (parsed.authority) {
          throw new InvalidInternalUriError(`${scheme}:// must not have authority component`, parsed.raw);
        }
        if (!parsed.path || parsed.path === '/') {
          throw new InvalidInternalUriError(`${scheme}:// requires a name/key`, parsed.raw);
        }
        // Note: actual secret/env resolution uses approved mechanisms only (not here)
        break;

      // Flexible schemes: require either authority or non-root path
      default:
        if (!parsed.authority && (!parsed.path || parsed.path === '/')) {
          throw new InvalidInternalUriError(
            `${scheme}:// requires target in authority or path`,
            parsed.raw
          );
        }
        break;
    }
  }

  /**
   * Check if a scheme string is a known internal scheme (without full parse).
   */
  isKnownScheme(scheme: string): scheme is InternalUriScheme {
    return KNOWN_SCHEMES.has(scheme.toLowerCase() as InternalUriScheme);
  }
}

export default InternalUriSchemeRouter;
