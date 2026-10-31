export interface ScenarioResponseHeaders {
  retryAfterSeconds?: number;
  retryAfterDateOffsetSeconds?: number;
  cache?: "no-store" | "revalidate" | "public-short";
  maxAgeSeconds?: number;
  challenge?: "basic" | "bearer";
}
export function parseResponseHeaders(input: unknown, status: number): ScenarioResponseHeaders {
  const fail = (): never => { throw new Error("Invalid scenario: unsupported or unsafe response-header action"); };
  if (!input || typeof input !== "object" || Array.isArray(input)) fail();
  const value = input as ScenarioResponseHeaders;
  if (!Object.keys(value).length || Object.keys(value).some(key => !["retryAfterSeconds", "retryAfterDateOffsetSeconds", "cache", "maxAgeSeconds", "challenge"].includes(key))) fail();
  const seconds = (number: unknown) => Number.isInteger(number) && Number(number) >= 0 && Number(number) <= 86400;
  if (value.retryAfterSeconds !== undefined && !seconds(value.retryAfterSeconds) || value.retryAfterDateOffsetSeconds !== undefined && !seconds(value.retryAfterDateOffsetSeconds) || value.retryAfterSeconds !== undefined && value.retryAfterDateOffsetSeconds !== undefined) fail();
  if (value.cache !== undefined && !["no-store", "revalidate", "public-short"].includes(value.cache)) fail();
  if (value.cache === "public-short") { if (status !== 404 || !seconds(value.maxAgeSeconds) || value.maxAgeSeconds > 3600) fail(); }
  else if (value.maxAgeSeconds !== undefined) fail();
  if (value.challenge !== undefined && (status !== 401 || !["basic", "bearer"].includes(value.challenge))) fail();
  if (status === 401 && !value.challenge || [401,429].includes(status) && value.cache && value.cache !== "no-store") fail();
  return { ...(value.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: value.retryAfterSeconds }),
    ...(value.retryAfterDateOffsetSeconds === undefined ? {} : { retryAfterDateOffsetSeconds: value.retryAfterDateOffsetSeconds }),
    ...(value.cache === undefined ? {} : { cache: value.cache }), ...(value.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: value.maxAgeSeconds }),
    ...(value.challenge === undefined ? {} : { challenge: value.challenge }) };
}
export function responseHeaders(value?: ScenarioResponseHeaders, now = Date.now()): Record<string,string> {
  if (!value) return {};
  const headers: Record<string,string> = {};
  if (value.retryAfterSeconds !== undefined) headers['Retry-After'] = String(value.retryAfterSeconds);
  if (value.retryAfterDateOffsetSeconds !== undefined) headers['Retry-After'] = new Date(now + value.retryAfterDateOffsetSeconds * 1000).toUTCString();
  if (value.cache) headers['Cache-Control'] = value.cache === 'no-store' ? 'no-store' : value.cache === 'revalidate' ? 'private, no-cache' : `public, max-age=${value.maxAgeSeconds}`;
  if (value.challenge) headers['WWW-Authenticate'] = value.challenge === 'basic' ? 'Basic realm="simulator", charset="UTF-8"' : 'Bearer realm="simulator"';
  return headers;
}
