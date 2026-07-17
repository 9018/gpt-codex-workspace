export function createTuiAutopilotEvent(type, detail = {}) {
  return { type, at: new Date().toISOString(), ...detail };
}
