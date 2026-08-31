/**
 * Node-only resolver for the read-only QA collectors.
 *
 * The Android/Metro project intentionally uses extensionless TypeScript
 * imports. Node's strip-types loader does not resolve those imports by
 * default, so the evidence scripts use this resolver without changing
 * production module resolution.
 */

export async function resolve(specifier, context, defaultResolve) {
  try {
    return await defaultResolve(specifier, context, defaultResolve);
  } catch (error) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      throw error;
    }
    for (const extension of ['.ts', '.tsx', '.js', '.jsx']) {
      try {
        return await defaultResolve(
          `${specifier}${extension}`,
          context,
          defaultResolve,
        );
      } catch {
        // Try the next project extension.
      }
    }
    throw error;
  }
}
