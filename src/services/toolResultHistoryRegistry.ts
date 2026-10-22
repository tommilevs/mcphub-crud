import { getAppDataSource } from '../db/connection.js';
import { ToolResultRepositoryDb } from '../db/repositories/ToolResultRepository.js';
import type { ToolResultRepository } from './toolResultHistoryService.js';

let repository: ToolResultRepository | undefined;

export const getToolResultRepository = (): ToolResultRepository | undefined => {
  try {
    const dataSource = getAppDataSource();
    if (!dataSource.isInitialized) return undefined;
    repository ??= new ToolResultRepositoryDb(dataSource);
    return repository;
  } catch {
    return undefined;
  }
};

export const isToolResultHistoryAvailable = (): boolean => !!getToolResultRepository();
