// Which kind of second factor code was typed, from its shape alone: six digits are an
// authenticator code, anything else is read as a recovery code. A wrong guess only means
// the code fails its own check, with the same message either way.
export function factorKindOf(typed: string): 'totp' | 'recovery_code' {
  return /^\d{6}$/.test(typed.replace(/\s/g, '')) ? 'totp' : 'recovery_code';
}
