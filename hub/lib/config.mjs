// Settings from the environment: CLOUD_PILOT_<NAME>, or the older KIT_HUB_<NAME> (kit-cloud 1.x) when that is unset.
export function setting(name, env = process.env) {
  const now = env[`CLOUD_PILOT_${name}`];
  return now !== undefined && now !== '' ? now : env[`KIT_HUB_${name}`];
}
