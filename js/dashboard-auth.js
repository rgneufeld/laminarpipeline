import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm';

const supabase = createClient(
  'https://nhiqblznignfyxycdmsd.supabase.co',
  'sb_publishable_avD7yip20sKJDCwsU0IRAw_3TA-J5hS',
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);

const gate = document.querySelector('#authGate');
const form = document.querySelector('#authForm');
const emailInput = document.querySelector('#authEmail');
const passwordInput = document.querySelector('#authPassword');
const submit = document.querySelector('#authSubmit');
const message = document.querySelector('#authMessage');
const menuUser = document.querySelector('#appMenuUser');
const signOut = document.querySelector('#appMenuSignout');

function setMessage(value = '') {
  message.textContent = value;
}

function setSignedIn(email) {
  const signedIn = Boolean(email);
  gate.hidden = signedIn;
  menuUser.textContent = email || 'Sign in to access your workspace';
  signOut.hidden = !signedIn;
  document.body.classList.toggle('is-authenticated', signedIn);
}

async function loadSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    setSignedIn();
    setMessage(error.message);
    return;
  }
  setSignedIn(data.session?.user.email);
}

supabase.auth.onAuthStateChange((_event, session) => {
  setSignedIn(session?.user.email);
  if (session) setMessage();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!emailInput.value || !passwordInput.value) return;

  submit.disabled = true;
  submit.textContent = 'Signing in…';
  setMessage('Signing in…');
  const { error } = await supabase.auth.signInWithPassword({
    email: emailInput.value.trim(),
    password: passwordInput.value,
  });
  submit.disabled = false;
  submit.textContent = 'Sign in';
  if (error) setMessage(error.message);
});

signOut.addEventListener('click', async () => {
  await supabase.auth.signOut();
  passwordInput.focus();
});

void loadSession();
