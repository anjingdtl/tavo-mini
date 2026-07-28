/**
 * Converts a `file://` URI returned by the document picker to a path that
 * Android native modules and react-native-fs can open.
 *
 * The picker deliberately percent-encodes local URIs. Stripping the scheme
 * alone leaves Chinese (and other non-ASCII) file names encoded, which makes
 * `java.io.File` look for a different, non-existent path.
 */
export function localFileUriToPath(uri: string): string {
  const path = uri.replace(/^file:\/\//i, '');

  try {
    return decodeURIComponent(path);
  } catch {
    // Preserve the original path if a third-party provider returns malformed
    // percent escapes. The downstream reader can then report its normal error.
    return path;
  }
}
