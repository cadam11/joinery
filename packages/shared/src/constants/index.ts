export * from './ipc-channels';

// Application constants
export const APP_NAME = 'Joinery';

/**
 * The published documentation site. Every in-app "documentation" entry point must use this —
 * both of them pointed at a GitHub wiki that never existed until J-100, in two separate
 * literals, which is how the second outlived the ticket filed about the first.
 */
export const DOCS_SITE_URL = 'https://usejoinery.com/';
export const APP_ID = 'ca.adam11.joinery';

// Default values
export const DEFAULT_PORT = 1433;
export const DEFAULT_CONNECTION_TIMEOUT = 15;
export const DEFAULT_REQUEST_TIMEOUT = 30;

// SQL Server system databases
export const SYSTEM_DATABASES = ['master', 'model', 'msdb', 'tempdb'] as const;

// File extensions
export const BACKUP_EXTENSIONS = ['.bak', '.trn', '.dif'] as const;
export const QUERY_EXTENSIONS = ['.sql', '.tsql'] as const;
