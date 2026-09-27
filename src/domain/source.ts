/** Source lifecycle vocabulary. Separate dimensions, never one overloaded status (brief §13). */
export const SOURCE_KINDS = ["text", "file", "url"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_ORIGINS = ["user", "imported", "ai_saved"] as const;
export type SourceOrigin = (typeof SOURCE_ORIGINS)[number];

export const RETENTION_STATES = ["retained", "trashed", "purged"] as const;
export type Retention = (typeof RETENTION_STATES)[number];

export const INCLUSION_STATES = ["included", "ignored"] as const;
export type Inclusion = (typeof INCLUSION_STATES)[number];

export const PROCESSING_STAGES = ["extraction", "enrichment", "interpretation", "indexing"] as const;
export type ProcessingStage = (typeof PROCESSING_STAGES)[number];

export const PROCESSING_STATES = ["pending", "complete", "partial", "unsupported", "failed"] as const;
export type ProcessingState = (typeof PROCESSING_STATES)[number];

export const ASSIGNMENTS = ["explicit", "inferred"] as const;
export type Assignment = (typeof ASSIGNMENTS)[number];

export const ACTORS = ["user", "agent", "system"] as const;
export type Actor = (typeof ACTORS)[number];

/** Maximum size of one text capture, in UTF-16 code units. */
export const MAX_TEXT_LENGTH = 1_000_000;
