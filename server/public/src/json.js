// JSON parsing that tolerates the one common way producers get it wrong.
//
// Python's json.dumps and Gson's lenient toString() write a non-finite number
// as a bare NaN / Infinity / -Infinity token, which is not valid JSON, so a
// strict parse throws and the whole event (or recording line) would be lost.
// PROTOCOL.md says to send null for those, so on failure this retries with
// such tokens replaced by null. `onRepaired` is called when that retry is what
// succeeded. Shared by the server, the viewer's replay loader and
// benchmark/push-ndjson.js.
export function parseJsonTolerant(text, onRepaired) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const fixed = text.replace(/(?<=[:\[,\s])-?(?:NaN|Infinity)(?=[,\]}\s])/g, 'null');
    if (fixed !== text) {
      try {
        const value = JSON.parse(fixed);
        if (onRepaired) onRepaired();
        return value;
      } catch (e2) {
        // fall through to the original error
      }
    }
    throw e;
  }
}
