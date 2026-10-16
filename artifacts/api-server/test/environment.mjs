const isApplicationSetting = name => name.startsWith("ONAY_") || name.startsWith("TEZJET_");

/** Keep default-dependent fixtures independent of deployment configuration. */
export function withoutApplicationEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([name]) => !isApplicationSetting(name)));
}

/** Snapshot both prefixes so teardown also restores legacy deployment settings. */
export function isolateApplicationEnvironment() {
  const original = Object.fromEntries(Object.entries(process.env).filter(([name]) => isApplicationSetting(name)));
  const clear = () => {
    for (const name of Object.keys(process.env)) {
      if (isApplicationSetting(name)) delete process.env[name];
    }
  };
  clear();
  return () => {
    clear();
    Object.assign(process.env, original);
  };
}
