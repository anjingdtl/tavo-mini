/**
 * LEGACY shim (Kernel Final Closure §8.1). The continuation context
 * collection now lives in the unified Writing Source layer:
 *   src/services/writing/scenario/continuationSourceCollection.ts
 * Only legacy runners / tests may import this path. Production code must
 * import the writing-scenario module directly.
 */
export * from '../../writing/scenario/continuationSourceCollection';
