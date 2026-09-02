-- GENERATED FILE — do not edit by hand.
--
-- The MSSQL statements `packages/main` actually runs, produced by the same functions
-- `BackupRestoreService` calls: `buildMssqlBackupTsql` / `buildMssqlRestoreTsql` in
-- packages/main/src/services/sql/backup-args.ts.
--
-- Written by: packages/main/src/services/sql/mssql-preview-fixture.spec.ts
-- Read by:    packages/renderer/src/features/tsql-preview-drift.spec.ts
-- Regenerate: pnpm exec vitest run packages/main/src/services/sql/mssql-preview-fixture.spec.ts -u
--
-- Regenerating turns the renderer spec red until the dialogs’ previews are brought back
-- into line with whatever changed here. That is the entire point (J-112).

--- case: backup/full-compressed
BACKUP DATABASE [sales]
TO DISK = N'C:\Backups\sales.bak'
WITH INIT, COMPRESSION, STATS = 5;

--- case: backup/full-uncompressed
BACKUP DATABASE [sales]
TO DISK = N'C:\Backups\sales.bak'
WITH INIT, STATS = 5;

--- case: backup/differential
BACKUP DATABASE [sales]
TO DISK = N'C:\Backups\sales.bak'
WITH DIFFERENTIAL, INIT, COMPRESSION, STATS = 5;

--- case: backup/log
BACKUP LOG [sales]
TO DISK = N'C:\Backups\sales.bak'
WITH NOINIT, COMPRESSION, STATS = 5;

--- case: backup/described
BACKUP DATABASE [sales]
TO DISK = N'C:\Backups\sales.bak'
WITH INIT, COMPRESSION, DESCRIPTION = N'Nightly — Craig''s run', STATS = 5;

--- case: backup/awkward-names
BACKUP DATABASE [sales]]prod]
TO DISK = N'C:\Backups\it''s here.bak'
WITH INIT, STATS = 5;

--- case: restore/plain
RESTORE DATABASE [sales_copy]
FROM DISK = N'C:\Backups\sales.bak'
WITH
    RECOVERY,
    STATS = 5;

--- case: restore/replace-norecovery
RESTORE DATABASE [sales_copy]
FROM DISK = N'C:\Backups\sales.bak'
WITH
    REPLACE,
    NORECOVERY,
    STATS = 5;

--- case: restore/relocated
RESTORE DATABASE [sales_copy]
FROM DISK = N'C:\Backups\sales.bak'
WITH
    MOVE N'sales' TO N'D:\Data\sales_copy_sales.mdf',
    MOVE N'sales_log' TO N'L:\Logs\sales_copy_sales_log.ldf',
    RECOVERY,
    STATS = 5;

--- case: restore/awkward-names
RESTORE DATABASE [sales]]copy]
FROM DISK = N'C:\Backups\it''s here.bak'
WITH
    MOVE N'sales''data' TO N'D:\Data\it''s here.mdf',
    REPLACE,
    RECOVERY,
    STATS = 5;
