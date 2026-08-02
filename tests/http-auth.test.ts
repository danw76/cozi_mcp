import { describe, expect, it } from 'vitest';
import { isAuthorized } from '../src/http-server.js';

describe('isAuthorized (HTTP bearer gate)', () => {
  it('allows any request when no token is configured (open mode)', () => {
    expect(isAuthorized(undefined, '')).toBe(true);
    expect(isAuthorized('Bearer anything', '')).toBe(true);
  });

  it('rejects a missing Authorization header when a token is configured', () => {
    expect(isAuthorized(undefined, 'secret')).toBe(false);
    expect(isAuthorized('', 'secret')).toBe(false);
  });

  it('rejects a non-bearer scheme', () => {
    expect(isAuthorized('Basic secret', 'secret')).toBe(false);
    expect(isAuthorized('secret', 'secret')).toBe(false);
  });

  it('rejects a wrong token', () => {
    expect(isAuthorized('Bearer wrong', 'secret')).toBe(false);
  });

  it('rejects a token of a different length (no partial match)', () => {
    expect(isAuthorized('Bearer secretsecret', 'secret')).toBe(false);
    expect(isAuthorized('Bearer sec', 'secret')).toBe(false);
  });

  it('accepts the exact token', () => {
    expect(isAuthorized('Bearer secret', 'secret')).toBe(true);
  });

  it('is case-insensitive on the Bearer keyword and tolerates surrounding space', () => {
    expect(isAuthorized('bearer secret', 'secret')).toBe(true);
    expect(isAuthorized('  Bearer   secret  ', 'secret')).toBe(true);
  });
});
