import { createDatabase, withTenant } from '@drefyn/db';
import { createEngine } from '@drefyn/engine';
import pg from 'pg';

export const reads = [createDatabase, withTenant, createEngine, pg];
