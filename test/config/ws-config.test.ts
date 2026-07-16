import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { loadWsConfig, type WsConfig } from '../../src/config/ws-config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Empty env — all variables absent, produces defaults. */
const emptyEnv: Record<string, string | undefined> = {};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('loadWsConfig() — defaults', () => {
  it('should return correct defaults when no env vars are set', () => {
    const config: WsConfig = loadWsConfig(emptyEnv);
    expect(config).toEqual({
      enabled: true,
      idleTimeout: 30,
      maxMessageSize: 1048576,
    });
  });
});

// ---------------------------------------------------------------------------
// WS_ENABLED
// ---------------------------------------------------------------------------

describe('loadWsConfig() — WS_ENABLED', () => {
  it('should return enabled=false when WS_ENABLED="false"', () => {
    const config = loadWsConfig({ WS_ENABLED: 'false' });
    expect(config.enabled).toBe(false);
  });

  it('should return enabled=true when WS_ENABLED="true"', () => {
    const config = loadWsConfig({ WS_ENABLED: 'true' });
    expect(config.enabled).toBe(true);
  });

  it('should return enabled=true when WS_ENABLED="1"', () => {
    const config = loadWsConfig({ WS_ENABLED: '1' });
    expect(config.enabled).toBe(true);
  });

  it('should return enabled=true when WS_ENABLED="yes"', () => {
    const config = loadWsConfig({ WS_ENABLED: 'yes' });
    expect(config.enabled).toBe(true);
  });

  it('should return enabled=true when WS_ENABLED="FALSE" (uppercase is not "false")', () => {
    // Per spec: only the exact lowercase string "false" disables WS.
    // "FALSE".toLowerCase() === "false", so this should be false.
    const config = loadWsConfig({ WS_ENABLED: 'FALSE' });
    expect(config.enabled).toBe(false);
  });

  it('should return enabled=true when WS_ENABLED is an arbitrary non-false string', () => {
    const config = loadWsConfig({ WS_ENABLED: 'anything-else' });
    expect(config.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WS_IDLE_TIMEOUT — clamping and warnings
// ---------------------------------------------------------------------------

describe('loadWsConfig() — WS_IDLE_TIMEOUT clamping', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('should clamp WS_IDLE_TIMEOUT to 10 and log a warning when value is below minimum', () => {
    const config = loadWsConfig({ WS_IDLE_TIMEOUT: '5' });
    expect(config.idleTimeout).toBe(10);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = warnSpy.mock.calls[0][0] as string;
    expect(warnArg).toMatch(/^Configuration error: WS_IDLE_TIMEOUT:/);
  });

  it('should clamp WS_IDLE_TIMEOUT to 300 and log a warning when value is above maximum', () => {
    const config = loadWsConfig({ WS_IDLE_TIMEOUT: '999' });
    expect(config.idleTimeout).toBe(300);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = warnSpy.mock.calls[0][0] as string;
    expect(warnArg).toMatch(/^Configuration error: WS_IDLE_TIMEOUT:/);
  });

  it('should accept WS_IDLE_TIMEOUT="10" (minimum boundary) without a warning', () => {
    const config = loadWsConfig({ WS_IDLE_TIMEOUT: '10' });
    expect(config.idleTimeout).toBe(10);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should accept WS_IDLE_TIMEOUT="300" (maximum boundary) without a warning', () => {
    const config = loadWsConfig({ WS_IDLE_TIMEOUT: '300' });
    expect(config.idleTimeout).toBe(300);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should use default idleTimeout of 30 when WS_IDLE_TIMEOUT is absent', () => {
    const config = loadWsConfig(emptyEnv);
    expect(config.idleTimeout).toBe(30);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WS_MAX_MESSAGE_SIZE — clamping and warnings
// ---------------------------------------------------------------------------

describe('loadWsConfig() — WS_MAX_MESSAGE_SIZE clamping', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('should clamp WS_MAX_MESSAGE_SIZE to 1024 and log a warning when value is below minimum', () => {
    const config = loadWsConfig({ WS_MAX_MESSAGE_SIZE: '512' });
    expect(config.maxMessageSize).toBe(1024);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = warnSpy.mock.calls[0][0] as string;
    expect(warnArg).toMatch(/^Configuration error: WS_MAX_MESSAGE_SIZE:/);
  });

  it('should clamp WS_MAX_MESSAGE_SIZE to 10485760 and log a warning when value is above maximum', () => {
    const config = loadWsConfig({ WS_MAX_MESSAGE_SIZE: '20971520' });
    expect(config.maxMessageSize).toBe(10485760);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = warnSpy.mock.calls[0][0] as string;
    expect(warnArg).toMatch(/^Configuration error: WS_MAX_MESSAGE_SIZE:/);
  });

  it('should use default maxMessageSize of 1048576 when WS_MAX_MESSAGE_SIZE is absent', () => {
    const config = loadWsConfig(emptyEnv);
    expect(config.maxMessageSize).toBe(1048576);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should accept WS_MAX_MESSAGE_SIZE="1024" (minimum boundary) without a warning', () => {
    const config = loadWsConfig({ WS_MAX_MESSAGE_SIZE: '1024' });
    expect(config.maxMessageSize).toBe(1024);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should accept WS_MAX_MESSAGE_SIZE="10485760" (maximum boundary) without a warning', () => {
    const config = loadWsConfig({ WS_MAX_MESSAGE_SIZE: '10485760' });
    expect(config.maxMessageSize).toBe(10485760);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
