'use strict';

const MAX_AUTH_STAGES = 8;

// Fresh-connection policy for a repeated Password challenge.
//
// Some devices (Alcatel/OmniSwitch AOS with AAA) keep the failed authentication
// context for the lifetime of one SSH transport: after the first wrong answer
// they ask `Password:` again *inside the same keyboard-interactive exchange*,
// and reject even the correct secret because the session is already poisoned.
// Re-submitting into that client only spends another submission of the AAA
// attempt budget, so the policy is to end the transport and let the operator run
// again on a fresh connection with the corrected secret.
//
// The rule is deliberately narrow: only a conservative single non-echo
// `Password:` challenge, only when the configured login secret was already
// submitted in *this* factor, and never after RFC 4252 partial success (a new
// factor may legitimately ask for the password again). An operator answer is
// never counted here, so OTP/PIN/verification prompts and multi-question
// exchanges keep their dialog.
const REPROMPT_POLICY = 'fresh-on-password-reprompt';
const AUTH_RETRY_NEW_CONNECTION_REQUIRED = 'AUTH_RETRY_NEW_CONNECTION_REQUIRED';
const AUTH_RETRY_NEW_CONNECTION_MESSAGE =
  '장비가 동일 세션 내 비밀번호 재입력을 지원하지 않습니다. 새로운 연결로 다시 시도해 주세요.';

// True when the *configured login secret* was already answered in this factor
// and the same factor now asks for it again. A new factor (partial success)
// resets the counter, so MFA servers are unaffected.
function requiresFreshConnection(state) {
  return !!state && state.loginPasswordSubmitted === true && (state.factorPasswordAnswers || 0) > 0;
}

// The selector below decides which *method* is attempted next. A method attempt
// is not the same thing as a *secret submission*: a server may reject
// `keyboard-interactive` without ever asking a question (the method is
// unsupported), while an answered prompt really did put a secret on the wire.
// Device AAA policies count submissions, so the two are tracked separately and
// only a real submission may block a fallback method.
//
// Client-local, secret-free bookkeeping. One state per SSH client — a jump host
// and its target must never share one — and never stored globally or in the
// session store, so a failed attempt cannot leak into the next connection.
function createAuthenticationState() {
  return {
    // Completed factors. RFC 4252 partial success starts the next one.
    stage: 1,
    lastMethod: null,
    // A password-capable exchange in *this* factor really sent a secret and has
    // not been superseded by an explicit partial success.
    submittedThisStage: false,
    // Secret submissions in password-capable exchanges (automatic login
    // password or an operator answer). This is the count an AAA lockout sees.
    submissionCount: 0,
    // The *configured* login password was sent as part of this client's login.
    loginPasswordSubmitted: false,
    // Configured-login-password answers in the *current* factor. A second one in
    // the same factor is the poisoned-session signature (see REPROMPT_POLICY);
    // a new factor via partial success resets it to zero.
    factorPasswordAnswers: 0,
    // Set when the policy ended the client instead of answering again. Safe,
    // secret-free diagnostics only.
    repromptBlocked: false,
    lastSubmittedMethod: null,
    // Ordinary (partial=false) rejection after a real submission: no further
    // automatic method may re-send that secret for this factor.
    terminalRejection: false,
    // Non-empty keyboard-interactive rounds the application answered.
    promptRounds: 0,
    methodTrace: [],
    phase: 'probe',
  };
}

function submit(state, method) {
  if (!state) return;
  state.submittedThisStage = true;
  state.submissionCount += 1;
  state.lastSubmittedMethod = method;
}

// Called immediately before the configured login password goes on the wire:
// ssh2's own `password` request or an automatic keyboard-interactive answer.
function markLoginPasswordSubmitted(state, method = 'keyboard-interactive') {
  submit(state, method);
  if (state) {
    state.loginPasswordSubmitted = true;
    state.factorPasswordAnswers = (state.factorPasswordAnswers || 0) + 1;
  }
}

// An operator answer to a keyboard-interactive prompt. It may be an OTP rather
// than the login password, so it arms the submission gate without claiming the
// login password was used — and the answer is never promoted to it.
function markPromptAnswerSubmitted(state, method = 'keyboard-interactive') {
  submit(state, method);
}

// Safe diagnostics for local metadata and the terminal status event. Prompt
// text, answers and the secret itself are never included.
function authenticationSummary(state) {
  if (!state) return null;
  return {
    methodTrace: [...state.methodTrace],
    stages: state.stage,
    secretSubmissions: state.submissionCount,
    loginPasswordSubmitted: state.loginPasswordSubmitted,
    keyboardPromptRounds: state.promptRounds,
    terminalRejection: state.terminalRejection,
    // A device that asked for the login password twice on one transport. The
    // answer was intentionally not sent; the code says a fresh run is required.
    repromptPolicy: state.repromptBlocked ? REPROMPT_POLICY : undefined,
    phase: state.phase,
  };
}

// Probe once, then try only methods the server actually advertised. PuTTY's
// password-capable flow prefers keyboard-interactive over plain password.
function authenticationHandler(order, state = createAuthenticationState()) {
  const tried = new Set();
  const wireMethod = method => method === 'agent' ? 'publickey' : method;
  return (methodsLeft, partialSuccess) => {
    if (!tried.size) {
      tried.add('none');
      state.lastMethod = 'none';
      state.methodTrace.push('none');
      state.phase = 'method-selection';
      return 'none';
    }
    // RFC 4252 partial success completes one factor, not the whole login.
    // AAA servers may require keyboard-interactive again for the next factor.
    // A new factor re-arms the submission gate: the previous factor's secret was
    // already judged on its own and must neither block nor be replayed here.
    if (partialSuccess === true && tried.size > 1) {
      if (++state.stage > MAX_AUTH_STAGES) {
        state.terminalRejection = true; state.phase = 'rejected';
        return false;
      }
      tried.clear(); tried.add('none');
      state.submittedThisStage = false;
      // A new factor is entitled to ask for the login password again (an MFA
      // server may re-prompt for it); the poisoned-session reprompt rule counts
      // answers per factor and must not fire across a partial success.
      state.factorPasswordAnswers = 0;
      state.phase = 'method-selection';
    } else if (partialSuccess !== true && state.submittedThisStage) {
      // Core invariant: an ordinary rejection after a secret was really
      // submitted must not fall through to another password-capable method with
      // that same secret. Alcatel/OmniSwitch AAA counts every submission, so
      // the second one is what locks the account out. An ordinary retry belongs
      // on a new transport with corrected credentials — never here.
      state.terminalRejection = true; state.phase = 'rejected';
      return false;
    }
    // Some older servers omit the method list even though they accept a
    // configured method. Preserve that compatibility, with one attempt each.
    const allowed = new Set(Array.isArray(methodsLeft) && methodsLeft.length ? methodsLeft : order.map(wireMethod));
    for (const method of order) if (!tried.has(method) && allowed.has(wireMethod(method))) {
      tried.add(method);
      state.lastMethod = method;
      state.methodTrace.push(method);
      // `password` puts the configured login secret on the wire in the same
      // request, so it is a submission at selection time. keyboard-interactive
      // is deliberately not marked here: choosing the method sends no secret,
      // so a server that refuses it outright may still be answered with one
      // plain password attempt.
      if (method === 'password') markLoginPasswordSubmitted(state, 'password');
      return method;
    }
    return false;
  };
}

function isPasswordChallenge(prompts, name = '', instructions = '') {
  if (prompts.length !== 1 || prompts[0].echo) return false;
  const label = String(prompts[0].prompt || '').trim();
  // A saved login password is not an OTP, PIN, password-change confirmation,
  // or response to an arbitrary challenge. Those always retain their dialog.
  if (/\b(?:otp|token|code|pin|verification|challenge|new|old|current|confirm|repeat|expired)\b|one[ -]?time|일회|인증번호|새\s*(?:암호|비밀번호)|기존\s*(?:암호|비밀번호)/i.test(`${name} ${instructions} ${label}`)) return false;
  return !label || /\b(?:password|passwd)\b|비밀번호|암호/i.test(label);
}
module.exports = {
  authenticationHandler, isPasswordChallenge, createAuthenticationState,
  markLoginPasswordSubmitted, markPromptAnswerSubmitted, authenticationSummary,
  requiresFreshConnection, REPROMPT_POLICY,
  AUTH_RETRY_NEW_CONNECTION_REQUIRED, AUTH_RETRY_NEW_CONNECTION_MESSAGE,
  MAX_AUTH_STAGES,
};
