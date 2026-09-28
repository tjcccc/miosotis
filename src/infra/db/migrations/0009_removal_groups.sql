-- Items moved to the trash together by one `miosotis remove` share a removal ID, so restoring a Source
-- also brings back the artifacts that were removed with it. Cleared on restore.
ALTER TABLE sources ADD COLUMN removed_with TEXT;
ALTER TABLE artifacts ADD COLUMN removed_with TEXT;
