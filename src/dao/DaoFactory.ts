import { CredentialBindingDao, CredentialBindingDaoImpl } from './CredentialBindingDao.js';
import { UserDao, UserDaoImpl } from './UserDao.js';
import { ServerDao, ServerDaoImpl } from './ServerDao.js';
import { GroupDao, GroupDaoImpl } from './GroupDao.js';
import { SystemConfigDao, SystemConfigDaoImpl } from './SystemConfigDao.js';
import { UserConfigDao, UserConfigDaoImpl } from './UserConfigDao.js';
import { OAuthClientDao, OAuthClientDaoImpl } from './OAuthClientDao.js';
import { OAuthTokenDao, OAuthTokenDaoImpl } from './OAuthTokenDao.js';
import { BearerKeyDao, BearerKeyDaoImpl } from './BearerKeyDao.js';
import { ActivityDao } from './ActivityDao.js';
import { BuiltinPromptDao, BuiltinPromptDaoImpl } from './BuiltinPromptDao.js';
import { BuiltinResourceDao, BuiltinResourceDaoImpl } from './BuiltinResourceDao.js';
import { logger } from '../utils/logger.js';
import { serializeJsonDao } from '../services/jsonDaoTransaction.js';
import { getSettingsPath } from '../config/index.js';

/**
 * DAO Factory interface for creating DAO instances
 */
export interface DaoFactory {
  getCredentialBindingDao(): CredentialBindingDao;
  getUserDao(): UserDao;
  getServerDao(): ServerDao;
  getGroupDao(): GroupDao;
  getSystemConfigDao(): SystemConfigDao;
  getUserConfigDao(): UserConfigDao;
  getOAuthClientDao(): OAuthClientDao;
  getOAuthTokenDao(): OAuthTokenDao;
  getBearerKeyDao(): BearerKeyDao;
  getBuiltinPromptDao(): BuiltinPromptDao;
  getBuiltinResourceDao(): BuiltinResourceDao;
  getActivityDao?(): ActivityDao; // Optional - only available in database mode
}

/**
 * Default DAO factory implementation using JSON file-based DAOs
 */
export class JsonFileDaoFactory implements DaoFactory {
  private static instance: JsonFileDaoFactory;

  private userDao: UserDao | null = null;
  private serverDao: ServerDao | null = null;
  private groupDao: GroupDao | null = null;
  private systemConfigDao: SystemConfigDao | null = null;
  private userConfigDao: UserConfigDao | null = null;
  private oauthClientDao: OAuthClientDao | null = null;
  private oauthTokenDao: OAuthTokenDao | null = null;
  private bearerKeyDao: BearerKeyDao | null = null;
  private builtinPromptDao: BuiltinPromptDao | null = null;
  private builtinResourceDao: BuiltinResourceDao | null = null;

  /**
   * Get singleton instance
   */
  public static getInstance(): JsonFileDaoFactory {
    if (!JsonFileDaoFactory.instance) {
      JsonFileDaoFactory.instance = new JsonFileDaoFactory();
    }
    return JsonFileDaoFactory.instance;
  }

  private constructor() {
    // Private constructor for singleton
  }

  getCredentialBindingDao(): CredentialBindingDao {
    return new CredentialBindingDaoImpl();
  }

  getUserDao(): UserDao {
    if (!this.userDao) {
      this.userDao = serializeJsonDao(new UserDaoImpl(), getSettingsPath);
    }
    return this.userDao;
  }

  getServerDao(): ServerDao {
    if (!this.serverDao) {
      this.serverDao = serializeJsonDao(new ServerDaoImpl(), getSettingsPath);
    }
    return this.serverDao;
  }

  getGroupDao(): GroupDao {
    if (!this.groupDao) {
      this.groupDao = serializeJsonDao(new GroupDaoImpl(), getSettingsPath);
    }
    return this.groupDao;
  }

  getSystemConfigDao(): SystemConfigDao {
    if (!this.systemConfigDao) {
      this.systemConfigDao = serializeJsonDao(new SystemConfigDaoImpl(), getSettingsPath, true);
    }
    return this.systemConfigDao;
  }

  getUserConfigDao(): UserConfigDao {
    if (!this.userConfigDao) {
      this.userConfigDao = serializeJsonDao(new UserConfigDaoImpl(), getSettingsPath);
    }
    return this.userConfigDao;
  }

  getOAuthClientDao(): OAuthClientDao {
    if (!this.oauthClientDao) {
      this.oauthClientDao = serializeJsonDao(new OAuthClientDaoImpl(), getSettingsPath);
    }
    return this.oauthClientDao;
  }

  getOAuthTokenDao(): OAuthTokenDao {
    if (!this.oauthTokenDao) {
      this.oauthTokenDao = serializeJsonDao(new OAuthTokenDaoImpl(), getSettingsPath);
    }
    return this.oauthTokenDao;
  }

  getBearerKeyDao(): BearerKeyDao {
    if (!this.bearerKeyDao) {
      this.bearerKeyDao = serializeJsonDao(new BearerKeyDaoImpl(), getSettingsPath);
    }
    return this.bearerKeyDao;
  }

  getBuiltinPromptDao(): BuiltinPromptDao {
    if (!this.builtinPromptDao) {
      this.builtinPromptDao = serializeJsonDao(new BuiltinPromptDaoImpl(), getSettingsPath);
    }
    return this.builtinPromptDao;
  }

  getBuiltinResourceDao(): BuiltinResourceDao {
    if (!this.builtinResourceDao) {
      this.builtinResourceDao = serializeJsonDao(new BuiltinResourceDaoImpl(), getSettingsPath);
    }
    return this.builtinResourceDao;
  }

  /**
   * Reset all cached DAO instances (useful for testing)
   */
  public resetInstances(): void {
    this.userDao = null;
    this.serverDao = null;
    this.groupDao = null;
    this.systemConfigDao = null;
    this.userConfigDao = null;
    this.oauthClientDao = null;
    this.oauthTokenDao = null;
    this.bearerKeyDao = null;
    this.builtinPromptDao = null;
    this.builtinResourceDao = null;
  }
}

/**
 * Global DAO factory instance
 */
let daoFactory: DaoFactory = JsonFileDaoFactory.getInstance();

/**
 * Set the global DAO factory (useful for dependency injection)
 */
export function setDaoFactory(factory: DaoFactory): void {
  daoFactory = factory;
}

/**
 * Get the global DAO factory
 */
export function getDaoFactory(): DaoFactory {
  return daoFactory;
}

/**
 * Switch to database-backed DAOs based on environment variable
 * This is synchronous and should be called during app initialization
 */
export async function initializeDaoFactory(): Promise<void> {
  // If USE_DB is explicitly set, use its value; otherwise, auto-detect based on DB_URL presence
  const useDatabase =
    process.env.USE_DB !== undefined ? process.env.USE_DB === 'true' : !!process.env.DB_URL;
  if (useDatabase) {
    logger.log('Using database-backed DAO implementations');
    // Dynamic import to avoid circular dependencies
    const { DatabaseDaoFactory } = await import('./DatabaseDaoFactory.js');
    setDaoFactory(DatabaseDaoFactory.getInstance());
  } else {
    logger.log('Using file-based DAO implementations');
    setDaoFactory(JsonFileDaoFactory.getInstance());
  }
}

/**
 * Convenience functions to get specific DAOs
 */
export function getUserDao(): UserDao {
  return getDaoFactory().getUserDao();
}

export function getServerDao(): ServerDao {
  return getDaoFactory().getServerDao();
}

export function getGroupDao(): GroupDao {
  return getDaoFactory().getGroupDao();
}

export function getSystemConfigDao(): SystemConfigDao {
  return getDaoFactory().getSystemConfigDao();
}

export function getUserConfigDao(): UserConfigDao {
  return getDaoFactory().getUserConfigDao();
}

export function getOAuthClientDao(): OAuthClientDao {
  return getDaoFactory().getOAuthClientDao();
}

export function getOAuthTokenDao(): OAuthTokenDao {
  return getDaoFactory().getOAuthTokenDao();
}

export function getBearerKeyDao(): BearerKeyDao {
  return getDaoFactory().getBearerKeyDao();
}

export function getBuiltinPromptDao(): BuiltinPromptDao {
  return getDaoFactory().getBuiltinPromptDao();
}

export function getBuiltinResourceDao(): BuiltinResourceDao {
  return getDaoFactory().getBuiltinResourceDao();
}

export function getActivityDao(): ActivityDao | undefined {
  return getDaoFactory().getActivityDao?.();
}

/**
 * Check if activity logging is available (database mode only)
 */
export function isActivityLoggingEnabled(): boolean {
  return typeof getDaoFactory().getActivityDao === 'function';
}

export function getCredentialBindingDao(): CredentialBindingDao {
  return getDaoFactory().getCredentialBindingDao();
}
