/**
 * Test/migration compatibility shim only. Production writing enters through
 * `writing/productionWritingEntry` and never imports this module.
 */
export * from './legacy/continuationV5Runner';
