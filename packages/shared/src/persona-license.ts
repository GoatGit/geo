/** Only explicit local research environments bypass the deployment license gate. */
export function personaHubUseAllowed(env: { NODE_ENV?: string; PERSONA_HUB_COMMERCIAL_LICENSE_REF?: string }): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test'
    || Boolean(env.PERSONA_HUB_COMMERCIAL_LICENSE_REF?.trim());
}
