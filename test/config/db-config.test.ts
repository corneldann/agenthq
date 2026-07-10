import { describe, it, expect } from 'bun:test';
import { loadDbConfig, type DbConfig } from '../../src/config/db-config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal env that produces valid SQLite defaults. */
const emptyEnv: Record<string, string | undefined> = {};

// ---------------------------------------------------------------------------
// SQLite defaults
// ---------------------------------------------------------------------------

describe('loadDbConfig() — SQLite defaults', () => {
  it('should return enabled=true when DB_ENABLED is absent', () => {
    const config = loadDbConfig(emptyEnv);
    expect(config.enabled).toBe(true);
  });

  it('should return type="sqlite" when DB_TYPE is absent', () => {
    const config = loadDbConfig(emptyEnv);
    expect(config.type).toBe('sqlite');
  });

  it('should return path=".agenthq.db" when DB_PATH is absent', () => {
    const config = loadDbConfig(emptyEnv);
    expect(config.path).toBe('.agenthq.db');
  });

  it('should return url=undefined when DB_URL is absent', () => {
    const config = loadDbConfig(emptyEnv);
    expect(config.url).toBeUndefined();
  });

  it('should return a complete DbConfig object with correct shape', () => {
    const config: DbConfig = loadDbConfig(emptyEnv);
    expect(config).toEqual({
      enabled: true,
      type: 'sqlite',
      path: '.agenthq.db',
      url: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// Explicit SQLite values
// ---------------------------------------------------------------------------

describe('loadDbConfig() — explicit SQLite values', () => {
  it('should use the provided DB_PATH', () => {
    const config = loadDbConfig({ DB_PATH: '/data/myapp.db' });
    expect(config.path).toBe('/data/myapp.db');
  });

  it('should return enabled=false when DB_ENABLED="false"', () => {
    const config = loadDbConfig({ DB_ENABLED: 'false' });
    expect(config.enabled).toBe(false);
  });

  it('should return enabled=true when DB_ENABLED="true"', () => {
    const config = loadDbConfig({ DB_ENABLED: 'true' });
    expect(config.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DB_ENABLED case-insensitivity
// ---------------------------------------------------------------------------

describe('loadDbConfig() — DB_ENABLED case-insensitivity', () => {
  it('should accept DB_ENABLED="True" (capital T) and set enabled=true', () => {
    const config = loadDbConfig({ DB_ENABLED: 'True' });
    expect(config.enabled).toBe(true);
  });

  it('should accept DB_ENABLED="TRUE" (all caps) and set enabled=true', () => {
    const config = loadDbConfig({ DB_ENABLED: 'TRUE' });
    expect(config.enabled).toBe(true);
  });

  it('should accept DB_ENABLED="False" (capital F) and set enabled=false', () => {
    const config = loadDbConfig({ DB_ENABLED: 'False' });
    expect(config.enabled).toBe(false);
  });

  it('should accept DB_ENABLED="FALSE" (all caps) and set enabled=false', () => {
    const config = loadDbConfig({ DB_ENABLED: 'FALSE' });
    expect(config.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DB_ENABLED — invalid values throw
// ---------------------------------------------------------------------------

describe('loadDbConfig() — DB_ENABLED invalid values', () => {
  it('should throw when DB_ENABLED="yes"', () => {
    expect(() => loadDbConfig({ DB_ENABLED: 'yes' })).toThrow(
      "DB_ENABLED must be 'true' or 'false', got 'yes'",
    );
  });

  it('should throw when DB_ENABLED="no"', () => {
    expect(() => loadDbConfig({ DB_ENABLED: 'no' })).toThrow(
      "DB_ENABLED must be 'true' or 'false', got 'no'",
    );
  });

  it('should throw when DB_ENABLED="1"', () => {
    expect(() => loadDbConfig({ DB_ENABLED: '1' })).toThrow(
      "DB_ENABLED must be 'true' or 'false', got '1'",
    );
  });

  it('should throw when DB_ENABLED="0"', () => {
    expect(() => loadDbConfig({ DB_ENABLED: '0' })).toThrow(
      "DB_ENABLED must be 'true' or 'false', got '0'",
    );
  });

  it('should throw when DB_ENABLED="enabled"', () => {
    expect(() => loadDbConfig({ DB_ENABLED: 'enabled' })).toThrow(
      "DB_ENABLED must be 'true' or 'false', got 'enabled'",
    );
  });

  it('should include the actual value in the error message', () => {
    expect(() => loadDbConfig({ DB_ENABLED: 'yes' })).toThrow("got 'yes'");
  });
});

// ---------------------------------------------------------------------------
// Postgres — valid configuration
// ---------------------------------------------------------------------------

describe('loadDbConfig() — postgres with DB_URL', () => {
  it('should return type="postgres" and url when both DB_TYPE and DB_URL are set', () => {
    const config = loadDbConfig({
      DB_TYPE: 'postgres',
      DB_URL: 'postgres://user:pass@localhost:5432/mydb',
    });
    expect(config.type).toBe('postgres');
    expect(config.url).toBe('postgres://user:pass@localhost:5432/mydb');
  });

  it('should return enabled=true by default for postgres', () => {
    const config = loadDbConfig({
      DB_TYPE: 'postgres',
      DB_URL: 'postgres://user:pass@localhost:5432/mydb',
    });
    expect(config.enabled).toBe(true);
  });

  it('should preserve DB_PATH even when type is postgres', () => {
    const config = loadDbConfig({
      DB_TYPE: 'postgres',
      DB_URL: 'postgres://user:pass@localhost:5432/mydb',
      DB_PATH: '/custom/path.db',
    });
    expect(config.path).toBe('/custom/path.db');
  });
});

// ---------------------------------------------------------------------------
// Postgres — missing DB_URL throws
// ---------------------------------------------------------------------------

describe('loadDbConfig() — postgres missing DB_URL', () => {
  it('should throw when DB_TYPE=postgres and DB_URL is absent', () => {
    expect(() => loadDbConfig({ DB_TYPE: 'postgres' })).toThrow(
      'DB_URL is required when DB_TYPE=postgres',
    );
  });

  it('should throw when DB_TYPE=postgres and DB_URL is empty string', () => {
    expect(() => loadDbConfig({ DB_TYPE: 'postgres', DB_URL: '' })).toThrow(
      'DB_URL is required when DB_TYPE=postgres',
    );
  });
});

// ---------------------------------------------------------------------------
// DB_TYPE — invalid values throw
// ---------------------------------------------------------------------------

describe('loadDbConfig() — DB_TYPE invalid values', () => {
  it('should throw when DB_TYPE is an unsupported engine name', () => {
    expect(() => loadDbConfig({ DB_TYPE: 'mysql' })).toThrow(
      "DB_TYPE must be 'sqlite' or 'postgres', got 'mysql'",
    );
  });

  it('should throw when DB_TYPE is an empty string', () => {
    expect(() => loadDbConfig({ DB_TYPE: '' })).toThrow(
      "DB_TYPE must be 'sqlite' or 'postgres', got ''",
    );
  });

  it('should include the invalid value in the DB_TYPE error message', () => {
    expect(() => loadDbConfig({ DB_TYPE: 'mongodb' })).toThrow("got 'mongodb'");
  });
});
