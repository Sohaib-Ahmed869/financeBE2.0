import axios, { AxiosError } from 'axios';
import { getSapSession, invalidateSapSession } from './session';
import { logger } from '../lib/logger';
import { AppError } from '../lib/errors';

export interface SapPaginated<T> {
  value: T[];
  /** Relative or absolute next-page URL when there are more results. */
  'odata.nextLink'?: string;
}

interface SapGetOptions {
  /** When true, automatically retries once after a 401 (session expired). */
  retryOn401?: boolean;
  timeoutMs?: number;
  /**
   * Sets the `Prefer: odata.maxpagesize=N` header — the canonical way to set
   * page size on SAP B1 Service Layer. Don't conflate with `$top`, which caps
   * the *total* result set and disables pagination after N rows.
   */
  maxPageSize?: number;
}

/**
 * GET against the SAP B1 Service Layer for a specific tenant. Handles
 * session re-login transparently on 401. `path` may be:
 *   - a Service Layer relative path: 'Invoices?$top=20'
 *   - an `odata.nextLink` value (relative): 'Invoices?$skip=20'
 *   - a fully-qualified URL (also fine).
 */
export async function sapGet<T>(
  companyKey: string,
  path: string,
  opts: SapGetOptions = {},
): Promise<T> {
  const session = await getSapSession(companyKey);
  const url = path.startsWith('http') ? path : `${session.baseUrl}/${path.replace(/^\//, '')}`;

  const headers: Record<string, string> = {
    Cookie: session.cookie,
    'Content-Type': 'application/json',
  };
  if (opts.maxPageSize && opts.maxPageSize > 0) {
    headers.Prefer = `odata.maxpagesize=${opts.maxPageSize}`;
  }

  try {
    const response = await axios.get<T>(url, {
      headers,
      timeout: opts.timeoutMs ?? 60_000,
      validateStatus: () => true,
    });
    if (response.status === 401 && opts.retryOn401 !== false) {
      invalidateSapSession(companyKey);
      logger.warn({ companyKey, url }, 'sap.401_retry');
      return sapGet<T>(companyKey, path, { ...opts, retryOn401: false });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new AppError(
        `SAP GET ${url} → ${response.status}: ${JSON.stringify(response.data)}`,
        response.status >= 500 ? 502 : response.status,
        'SAP_REQUEST_FAILED',
        response.data,
      );
    }
    return response.data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof AxiosError) {
      throw new AppError(
        `SAP GET ${url} failed: ${err.message}`,
        502,
        'SAP_REQUEST_FAILED',
        { code: err.code },
      );
    }
    throw err;
  }
}

/** POST against the SAP Service Layer (used for the future write-back path). */
export async function sapPost<T>(
  companyKey: string,
  path: string,
  body: unknown,
  opts: SapGetOptions = {},
): Promise<T> {
  const session = await getSapSession(companyKey);
  const url = path.startsWith('http') ? path : `${session.baseUrl}/${path.replace(/^\//, '')}`;

  try {
    const response = await axios.post<T>(url, body, {
      headers: { Cookie: session.cookie, 'Content-Type': 'application/json' },
      timeout: opts.timeoutMs ?? 60_000,
      validateStatus: () => true,
    });
    if (response.status === 401 && opts.retryOn401 !== false) {
      invalidateSapSession(companyKey);
      return sapPost<T>(companyKey, path, body, { ...opts, retryOn401: false });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new AppError(
        `SAP POST ${url} → ${response.status}: ${JSON.stringify(response.data)}`,
        response.status >= 500 ? 502 : response.status,
        'SAP_REQUEST_FAILED',
        response.data,
      );
    }
    return response.data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof AxiosError) {
      throw new AppError(
        `SAP POST ${url} failed: ${err.message}`,
        502,
        'SAP_REQUEST_FAILED',
        { code: err.code },
      );
    }
    throw err;
  }
}
