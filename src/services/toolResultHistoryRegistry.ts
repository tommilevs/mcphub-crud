import { getAppDataSource } from '../db/connection.js';
import { ToolResultRepositoryDb } from '../db/repositories/ToolResultRepository.js';
import type { ToolResultRepository } from './toolResultHistoryService.js';

let repository: ToolResultRepository | undefined;
let repositorySource: ReturnType<typeof getAppDataSource> | undefined;

export const getToolResultRepository = (): ToolResultRepository | undefined => {
  try {
    const dataSource = getAppDataSource();
    if (!dataSource.isInitialized) return undefined;
    if (!repository || repositorySource !== dataSource) {
      repository = new ToolResultRepositoryDb(dataSource);
      repositorySource = dataSource;
    }
    return repository;
  } catch {
    return undefined;
  }
};

export const isToolResultHistoryAvailable = (): boolean => !!getToolResultRepository();
