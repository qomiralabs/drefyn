import {
  createPublishedDatabase,
  parsePublishedReaderConfig,
  withPublishedReader,
} from '@drefyn/db';
import type { Database } from '@drefyn/db';
import { createPublishedReader, publishedStore, type PublishedReader } from '@drefyn/engine';
import { sql } from 'kysely';

export const reads = [createPublishedDatabase, parsePublishedReaderConfig, withPublishedReader];
export const reader = [createPublishedReader, publishedStore, sql];
export type Handles = Database | PublishedReader;
