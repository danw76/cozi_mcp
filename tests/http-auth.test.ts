import { describe, expect, it } from 'vitest';
import { isAuthorized, matchesMcpEndpoint } from '../src/http-server.js';

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

describe('matchesMcpEndpoint (path-secret gate)', () => {
  it('matches only the exact base path when no secret is configured', () => {
    expect(matchesMcpEndpoint('/mcp', '/mcp', '')).toBe(true);
    expect(matchesMcpEndpoint('/mcp/', '/mcp', '')).toBe(false);
    expect(matchesMcpEndpoint('/mcp/anything', '/mcp', '')).toBe(false);
    expect(matchesMcpEndpoint('/other', '/mcp', '')).toBe(false);
  });

  it('matches the base+secret path when a secret is configured', () => {
    expect(matchesMcpEndpoint('/mcp/s3cr3t', '/mcp', 's3cr3t')).toBe(true);
  });

  it('does NOT match the bare base path when a secret is configured (base 404s)', () => {
    expect(matchesMcpEndpoint('/mcp', '/mcp', 's3cr3t')).toBe(false);
    expect(matchesMcpEndpoint('/mcp/', '/mcp', 's3cr3t')).toBe(false);
  });

  it('rejects a wrong or partial secret segment', () => {
    expect(matchesMcpEndpoint('/mcp/wrong', '/mcp', 's3cr3t')).toBe(false);
    expect(matchesMcpEndpoint('/mcp/s3cr3', '/mcp', 's3cr3t')).toBe(false);
    expect(matchesMcpEndpoint('/mcp/s3cr3tX', '/mcp', 's3cr3t')).toBe(false);
  });

  it('does not treat extra path segments after the secret as a match', () => {
    expect(matchesMcpEndpoint('/mcp/s3cr3t/extra', '/mcp', 's3cr3t')).toBe(false);
  });
});
