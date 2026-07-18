/** Submit text to the Codex editor in paced chunks, then press Enter. */
export async function submitTuiText(ptySession, text, options = {}) {
  if (!ptySession?.write) throw new Error('ptySession.write is required');
  const input = String(text ?? '');
  if (!input) throw new Error('text is required');
  const sleep = options.sleep_fn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const chunkSize = Math.max(1, Number(options.chunk_size ?? 16));
  const chunkDelayMs = Math.max(0, Number(options.chunk_delay_ms ?? 8));
  if (options.clear_existing !== false) {
    ptySession.write('\u0015');
    await sleep(Math.max(0, Number(options.clear_settle_ms ?? 50)));
  }
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    ptySession.write(input.slice(offset, offset + chunkSize));
    if (chunkDelayMs > 0 && offset + chunkSize < input.length) await sleep(chunkDelayMs);
  }
  await sleep(Math.max(0, Number(options.submit_settle_ms ?? 150)));
  ptySession.write('\r');
}
