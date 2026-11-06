// Customer Portal Redesign — Sign-in page (handoff §8). Pure logic + source
// checks, Node's built-in runner (no DOM in this suite). Run:
//   npx --prefix ../server tsx --test tests/signInPage.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loginSchema } from '../src/pages/auth/login.schema';
import { fieldMessageId } from '../src/components/forms/Field';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const page = strip(read('../src/pages/auth/LoginPage.tsx'));
const layout = strip(read('../src/layouts/AuthLayout.tsx'));

describe('show / hide password toggle', () => {
  test('label switches with the state and aria-pressed reflects it', () => {
    assert.ok(page.includes("aria-label={showPassword ? 'Hide password' : 'Show password'}"));
    assert.ok(page.includes('aria-pressed={showPassword}'));
    assert.ok(page.includes("type={showPassword ? 'text' : 'password'}"));
    assert.ok(page.includes('onClick={() => setShowPassword((v) => !v)}'));
    assert.ok(page.includes('type="button"'), 'toggle never submits the form');
  });
});

describe('field error wiring', () => {
  test('both inputs set aria-invalid and point aria-describedby at the FieldShell message id', () => {
    assert.ok(page.includes('aria-invalid={errors.email ? true : undefined}'));
    assert.ok(page.includes('aria-describedby={errors.email ? fieldMessageId(emailId) : undefined}'));
    assert.ok(page.includes('aria-invalid={errors.password ? true : undefined}'));
    assert.ok(page.includes('aria-describedby={errors.password ? fieldMessageId(pwId) : undefined}'));
    assert.ok(page.includes('htmlFor={emailId}') && page.includes('id={emailId}'));
    assert.ok(page.includes('htmlFor={pwId}') && page.includes('id={pwId}'));
  });

  test('FieldShell renders the message with id = fieldMessageId(htmlFor)', () => {
    assert.equal(fieldMessageId('abc'), 'abc-message');
    const shell = strip(read('../src/components/forms/Field.tsx'));
    assert.ok(shell.includes("<p id={fieldMessageId(htmlFor)} className={cn(messageSize, 'text-danger-700')}>"));
  });

  test('invalid border is danger-700; focus is a 2px brand-600 outline with 1px offset', () => {
    assert.ok(page.includes("errors.email ? 'border-danger-700' : 'border-line'"));
    assert.ok(page.includes("errors.password ? 'border-danger-700' : 'border-line'"));
    // danger-200 is too faint for a field boundary — only the alert box uses it.
    assert.equal(page.split('border-danger-200').length - 1, 1);
    assert.ok(page.includes('border border-danger-200 bg-danger-50'));
    const focus = 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600';
    assert.equal(page.split(focus).length - 1, 3, 'fields, eye button and submit');
  });

  test('validation messages are exactly the schema messages', () => {
    const empty = loginSchema.safeParse({ email: '', password: '' });
    assert.equal(empty.success, false);
    const msgs = empty.success ? [] : empty.error.issues.map((i) => `${i.path[0]}:${i.message}`);
    assert.ok(msgs.includes('email:Email is required.'));
    assert.ok(msgs.includes('password:Password is required.'));
    const bad = loginSchema.safeParse({ email: 'nope', password: 'x' });
    assert.ok(!bad.success && bad.error.issues.some((i) => i.message === 'Enter a valid email address.'));
    const ok = loginSchema.safeParse({ email: '  A@B.TEST ', password: ' pw ' });
    assert.ok(ok.success);
    assert.equal(ok.success && ok.data.email, 'a@b.test');
    assert.equal(ok.success && ok.data.password, ' pw ', 'password is never trimmed');
  });
});

describe('form-level error alert', () => {
  test('role="alert" above the fields, referenced by the submit button', () => {
    assert.ok(page.includes('id={formErrorId}'));
    assert.ok(page.includes('role="alert"'));
    assert.ok(page.includes('aria-describedby={formError ? formErrorId : undefined}'));
    assert.ok(page.indexOf('role="alert"') < page.indexOf('label="Email"'), 'alert renders above the fields');
  });

  test('error wording stays generic', () => {
    for (const msg of [
      'Invalid email or password.',
      'Unable to sign in right now. Please try again.',
      'Please check the details you entered and try again.',
      'Something went wrong while signing in. Please try again.',
    ]) {
      assert.ok(page.includes(`'${msg}'`), msg);
    }
    assert.ok(!/inactive|not found|does not exist|no account with/i.test(page.replace(/'No account yet[^<]*/, '')));
  });
});

describe('behaviour unchanged', () => {
  test('useLogin, redirectTo from location.state.from, onTouched, noValidate, autocomplete, loading', () => {
    assert.ok(page.includes('const { login, isLoading } = useLogin();'));
    assert.ok(page.includes('const fromState = (location.state as { from?: unknown } | null)?.from;'));
    assert.ok(page.includes("const redirectTo = typeof fromState === 'string' ? fromState : null;"));
    assert.ok(page.includes('{ email: values.email, password: values.password },'));
    assert.ok(page.includes("mode: 'onTouched'"));
    assert.ok(page.includes('resolver: zodResolver(loginSchema)'));
    assert.ok(page.includes('noValidate'));
    assert.ok(page.includes('autoComplete="username"'));
    assert.ok(page.includes('autoComplete="current-password"'));
    assert.ok(page.includes('autoCapitalize="none"'));
    assert.ok(page.includes('spellCheck={false}'));
    assert.ok(page.includes('loading={isLoading || isSubmitting}'));
  });

  test('shared Button sm / md classes are unchanged', () => {
    const btn = read('../src/components/ui/Button.tsx');
    assert.ok(btn.includes("sm: 'h-8 px-3 text-xs gap-1.5 rounded-control',"));
    assert.ok(btn.includes("md: 'h-10 px-4 text-sm gap-2 rounded-control',"));
    assert.ok(btn.includes("size === 'lg' ? null : 'font-medium'"));
  });
});

describe('guardrails', () => {
  test('no forgot-password, remember-me, sign-up, social login or role picker', () => {
    for (const src of [page, layout]) {
      assert.ok(!/forgot|reset password|remember me|sign up|signup|register now|create account|google|facebook|apple|microsoft/i.test(src));
      assert.ok(!/<select|role picker|choose (your )?role|i am a/i.test(src));
    }
  });

  test('brand panel is decorative: h2 headline, aria-hidden rings, chips are labels not links', () => {
    assert.ok(layout.includes('<section\n        aria-label="Spring Delivery"'));
    assert.ok(layout.includes('<h2'));
    assert.ok(!layout.includes('<h1'));
    assert.ok(layout.includes('-z-10 size-[30rem]" aria-hidden="true"'));
    const chips = layout.slice(layout.indexOf('ROLE_LABELS.map'));
    assert.ok(chips.includes('<li'));
    assert.ok(!/<a |<Link|<button|onClick|href=/.test(layout));
    assert.ok(layout.includes('font-customer'), 'D4-A');
    assert.ok(page.includes('<h1'));
  });
});
