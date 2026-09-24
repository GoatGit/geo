import { describe, expect, it } from 'vitest';
import { personaHubUseAllowed } from '../src/persona-license';

describe('Persona Hub deployment license boundary', () => {
  it.each(['production', 'staging', 'preview', undefined])('requires authorization in %s', NODE_ENV => {
    expect(personaHubUseAllowed({ NODE_ENV })).toBe(false);
    expect(personaHubUseAllowed({ NODE_ENV, PERSONA_HUB_COMMERCIAL_LICENSE_REF: ' ' })).toBe(false);
  });
  it.each(['development', 'test'])('allows local research in %s', NODE_ENV => {
    expect(personaHubUseAllowed({ NODE_ENV })).toBe(true);
  });
  it('accepts an explicitly configured authorization reference', () => {
    expect(personaHubUseAllowed({ NODE_ENV: 'staging', PERSONA_HUB_COMMERCIAL_LICENSE_REF: 'agreement-reference' })).toBe(true);
  });
});
