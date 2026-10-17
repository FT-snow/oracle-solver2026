import Reveal from './Reveal.jsx';

const DOWNLOAD = '/oracle-solver-extension.zip';

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2v8m0 0 3-3m-3 3L5 7" />
      <path d="M2.5 12.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1" />
    </svg>
  );
}

function TerminalLines() {
  const lines = [
    [{ t: '$ ', c: 'g' }, { t: 'node auto.js', c: 't' }],
    [{ t: 'Connected to relay on 127.0.0.1:8787.', c: '' }],
    [{ t: 'Answer database ready: 1,721 questions.', c: '' }],
    [{ t: 'Waiting for questions...', c: '' }],
    [{ t: '', c: '' }],
    [{ t: 'QUESTION (qid=41)', c: 't' }],
    [{ t: 'Which statement removes all uncommitted changes?', c: '' }],
    [{ t: '  [1] COMMIT   [2] ROLLBACK   [3] SAVEPOINT', c: '' }],
    [{ t: '\u26A1 [DB HIT - 0ms]: [2] -> ROLLBACK', c: 'g' }],
    [{ t: 'Submitted answer [2] for qid=41 (source: cache).', c: 'g' }],
    [{ t: 'Extension clicked and submitted. Next section loading...', c: 'a' }]
  ];
  return lines.map((line, i) => (
    <div key={i}>
      {line.map((seg, j) => (
        <span key={j} className={seg.c}>{seg.t}</span>
      ))}
      {i === lines.length - 1 && <span className="caret" aria-hidden="true" />}
    </div>
  ));
}

export default function Page() {
  return (
    <>
      <nav className="top">
        <div className="wrap">
          <a className="brand" href="#top">ORACLE SOLVER <em>2026</em></a>
          <div className="navlinks">
            <a href="#how">How it works</a>
            <a href="#chrome">Add to Chrome</a>
            <a href="#access">Access control</a>
            <a href="#setup">Setup</a>
            <a href="#faq">FAQ</a>
            <a className="dl" href={DOWNLOAD} download>Download</a>
          </div>
        </div>
      </nav>

      <header className="hero" id="top">
        <div className="wrap">
          <Reveal>
            <p className="kicker">Final year project · Autonomous quiz engine</p>
            <h1>
              The Oracle Academy grinds itself. <em>Every answer, remembered.</em>
            </h1>
            <p className="lede">
              A Chrome extension and a local relay watch your Oracle Academy course, solve each quiz
              question from a 1,700+ answer database or Gemini, click Submit, close the assessment,
              and open the next section — page after page, course after course.
            </p>
            <div className="cta-row">
              <a className="btn-primary" href={DOWNLOAD} download>
                <DownloadIcon /> Download extension
              </a>
              <a className="btn-quiet" href="#setup">View setup guide</a>
            </div>
            <p className="hero-meta">v2.2.0 · Manifest V3 · 1,721 cached answers · no setup needed</p>
          </Reveal>

          <Reveal d={2}>
            <div className="term" role="img" aria-label="Terminal output of the solver running">
              <div className="term-bar"><i /><i /><i /><span>auto.js — oracle-solver2026</span></div>
              <div className="term-body"><TerminalLines /></div>
            </div>
          </Reveal>
        </div>
      </header>

      <section id="how">
        <div className="wrap">
          <Reveal>
            <p className="sec-label">How it works</p>
            <h2>Three moving parts, <em>zero clicking.</em></h2>
          </Reveal>
          <div className="steps">
            <Reveal as="div" className="step" d={0}>
              <div className="n">01</div>
              <h3>Load the extension</h3>
              <p>
                Download, unzip, then open <code>chrome://extensions</code> and use
                <code> Load unpacked</code> on the folder. The autopilot starts on
                academy.oracle.com pages.
              </p>
            </Reveal>
            <Reveal as="div" className="step" d={1}>
              <div className="n">02</div>
              <h3>No setup — it talks to the cloud</h3>
              <p>
                No terminals, no installs. The extension queries the shared
                1,700+ answer database directly (0 ms), and uses <em>your own</em> Gemini
                key (pasted in the popup) for unseen questions — saved back for everyone.
              </p>
            </Reveal>
            <Reveal as="div" className="step" d={2}>
              <div className="n">03</div>
              <h3>Sign in and let go</h3>
              <p>
                Sign in with the user ID issued to you — the account locks to your device on first
                login. The autopilot advances slides, starts quizzes, answers, and moves to the next
                section on its own.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      <section>
        <div className="wrap">
          <Reveal>
            <p className="sec-label">Capabilities</p>
            <h2>What it does <em>while you watch.</em></h2>
          </Reveal>
          <div className="bento">
            <Reveal as="div" className="card w4" d={0}>
              <h3><span className="tag">core</span> Full autopilot loop</h3>
              <ul>
                <li>Advances lesson slides ("Save and Continue") at a safe pace</li>
                <li>Starts assessments from the popup and answers every question</li>
                <li>Clicks Complete Assessment, confirms the modal, returns to the course outline</li>
                <li>Opens the next unfinished section automatically — the old "stuck on one quiz" bug is fixed</li>
              </ul>
            </Reveal>
            <Reveal as="div" className="card w2" d={1}>
              <h3><span className="tag">0 ms</span> Shared answer database</h3>
              <p>
                Every solved question is stored in one cloud database all users share.
                Repeated questions answer instantly — no AI call, no key, no waiting.
              </p>
            </Reveal>
            <Reveal as="div" className="card w2" d={0}>
              <h3><span className="tag">ai</span> Gemini solver</h3>
              <p>
                Multi-key rotation with rate-limit cooldowns, only live model names, and a
                deterministic fallback guess so a stalled answer never blocks the run.
              </p>
            </Reveal>
            <Reveal as="div" className="card w2" d={1}>
              <h3><span className="tag">resilient</span> Stuck-question watchdog</h3>
              <p>
                If a question stays on screen too long, the extension re-clicks Submit, tries
                alternate buttons, then reloads once. A quiz can no longer trap the loop.
              </p>
            </Reveal>
            <Reveal as="div" className="card w2" d={2}>
              <h3><span className="tag">control</span> Popup kill switch</h3>
              <p>
                One toggle pauses the autopilot on any page. Session status, relay health, and
                device identity are visible at a glance.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      <section id="chrome">
        <div className="wrap">
          <Reveal>
            <p className="sec-label">Add it to the browser</p>
            <h2>Four steps in <em>Chromium.</em></h2>
          </Reveal>
          <div className="steps chrome-steps">
            <Reveal as="div" className="step" d={0}>
              <div className="n">STEP 1</div>
              <h3>Get the zip</h3>
              <p>
                Hit <code>Download extension</code> and keep the file
                <code> oracle-solver-extension.zip</code> somewhere you control.
              </p>
            </Reveal>
            <Reveal as="div" className="step" d={1}>
              <div className="n">STEP 2</div>
              <h3>Unzip it</h3>
              <p>
                Extract the archive. You get a folder that contains
                <code> manifest.json</code> — that folder is the whole extension.
              </p>
            </Reveal>
            <Reveal as="div" className="step" d={2}>
              <div className="n">STEP 3</div>
              <h3>Chrome extensions page</h3>
              <p>
                Open a new tab and go to <code>chrome://extensions</code>. Switch on
                <code> Developer mode</code> (top right). Press
                <code> Load unpacked</code> and select the unzipped folder.
              </p>
            </Reveal>
            <Reveal as="div" className="step" d={3}>
              <div className="n">STEP 4</div>
              <h3>Pin it and sign in</h3>
              <p>
                Click the puzzle-piece icon in the toolbar and pin <em>Oracle Solver
                2026</em>. Open it, enter the user ID and password you were given, and the
                status dot turns green.
              </p>
            </Reveal>
          </div>
          <Reveal d={4}>
            <p className="sec-sub" style={{ marginTop: 24 }}>
              It only runs on <code style={{ fontFamily: 'var(--mono)', fontSize: '13px' }}>academy.oracle.com</code> tabs.
              The autopilot stays idle until the relay (<code style={{ fontFamily: 'var(--mono)', fontSize: '13px' }}>node auto.js</code>) is
              online and you are signed in.
            </p>
          </Reveal>
        </div>
      </section>

      <section id="access">
        <div className="wrap">
          <Reveal>
            <p className="sec-label">Access control</p>
            <h2>One account. <em>One device.</em></h2>
            <p className="sec-sub">
              Credentials are issued by the owner, not chosen. Passwords are scrypt-hashed. Sessions
              are bearer tokens. The first device to sign in claims the account — every other device
              is refused until the owner resets the binding.
            </p>
          </Reveal>
          <div className="lock-grid">
            <Reveal>
              <div className="lock-points">
                <div className="lock-point">
                  <span className="k">01</span>
                  <div>
                    <h4>Issued credentials</h4>
                    <p>The owner creates a user ID and hands you the password. No self-signup exists.</p>
                  </div>
                </div>
                <div className="lock-point">
                  <span className="k">02</span>
                  <div>
                    <h4>Device lock on first login</h4>
                    <p>The extension generates a private device ID. The account binds to it permanently.</p>
                  </div>
                </div>
                <div className="lock-point">
                  <span className="k">03</span>
                  <div>
                    <h4>Sharing fails closed</h4>
                    <p>Pass the password to a friend and their browser is rejected with a clear message.</p>
                  </div>
                </div>
                <div className="lock-point">
                  <span className="k">04</span>
                  <div>
                    <h4>Owner-side recovery</h4>
                    <p>Changing devices? The owner clears the binding in one command and you are back.</p>
                  </div>
                </div>
              </div>
            </Reveal>
            <Reveal d={1}>
              <div className="codeblock">
                <div className="cb-head"><span>owner console</span><span>convex · cloud</span></div>
                <pre>
                  <span className="c"># issue a friend an account</span>{'\n'}
                  <span className="g">$</span> node admin.js add-user rahul.k{'\n'}
                  {'\n'}
                  Created user &quot;rahul.k&quot;{'\n'}
                  {'  '}password: x9K2_mQv4Pz{'\n'}
                  {'  '}(first login locks the device){'\n'}
                  {'\n'}
                  <span className="c"># friend changed laptops?</span>{'\n'}
                  <span className="g">$</span> node admin.js reset-device rahul.k{'\n'}
                  {'\n'}
                  <span className="c"># see everyone</span>{'\n'}
                  <span className="g">$</span> node admin.js list
                </pre>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <section id="setup">
        <div className="wrap">
          <Reveal>
            <p className="sec-label">Setup</p>
            <h2>Running it <em>takes five minutes.</em></h2>
          </Reveal>
          <div className="setup-grid">
            <Reveal d={0}>
              <div className="codeblock">
                <div className="cb-head"><span>1 · extension</span><span>chrome</span></div>
                <pre>
                  <span className="c"># unzip the download, then:</span>{'\n'}
                  1. open <span className="g">chrome://extensions</span>{'\n'}
                  2. enable <span className="g">Developer mode</span>{'\n'}
                  3. <span className="g">Load unpacked</span> → select the folder{'\n'}
                  4. click the toolbar icon and <span className="g">Sign in</span>
                </pre>
              </div>
            </Reveal>
            <Reveal d={1}>
              <div className="codeblock">
                <div className="cb-head"><span>2 · solver</span><span>terminal</span></div>
                <pre>
                  <span className="c"># clone the repo, configure once:</span>{'\n'}
                  <span className="g">$</span> cp .env.example .env{'\n'}
                  <span className="c"># add GEMINI_API_KEY, CONVEX_URL,</span>{'\n'}
                  <span className="c"># ADMIN_SECRET, AUTH_USER, AUTH_PASS</span>{'\n'}
                  {'\n'}
                  <span className="g">$</span> npm install{'\n'}
                  <span className="g">$</span> node auto.js
                </pre>
              </div>
            </Reveal>
          </div>
          <Reveal d={2}>
            <div className="codeblock">
              <div className="cb-head"><span>3 · get a free Gemini key</span><span>google ai studio</span></div>
              <pre>
                <span className="c"># takes one minute, no billing needed</span>{'\n'}
                1. open <span className="g">aistudio.google.com</span>{'\n'}
                2. sign in with your Google account{'\n'}
                3. click <span className="g">Get API key</span> → <span className="g">Create API key</span>{'\n'}
                4. copy the key — it starts with <span className="g">AIza…</span>{'\n'}
                5. paste it in the extension popup (after sign-in){'\n'}
                {'\n'}
                <span className="c"># note: database hits answer in 0 ms and</span>{'\n'}
                <span className="c"># the AI is only called for unseen questions</span>
              </pre>
            </div>
            <div className="codeblock" style={{ marginTop: 16 }}>
              <div className="cb-head"><span>4 · owner tools</span><span>optional</span></div>
              <pre>
                <span className="c"># fully-autonomous CLI mode (owner machine):</span>{'\n'}
                <span className="g">$</span> node auto.js{'\n'}
                {'\n'}
                <span className="c"># issue logins for friends:</span>{'\n'}
                <span className="g">$</span> node admin.js add-user rahul.k{'\n'}
                {'\n'}
                <span className="c"># browse the shared database anytime:</span>{'\n'}
                <span className="g">$</span> node answers.js --cloud --limit 50{'\n'}
                <span className="g">$</span> node answers.js --stats
              </pre>
            </div>
          </Reveal>
        </div>
      </section>

      <section id="faq">
        <div className="wrap">
          <Reveal>
            <p className="sec-label">FAQ</p>
            <h2>The questions <em>everyone asks.</em></h2>
          </Reveal>
          <Reveal d={1}>
            <div className="faq" style={{ marginTop: 44 }}>
              <details>
                <summary>It used to get stuck on the same quiz — is that fixed?<span className="x" /></summary>
                <div className="a">
                  Yes. Three changes: duplicate posts of the same question now return the same
                  <code> qid</code> with the cached answer instead of re-solving; a watchdog
                  re-clicks Submit at 20s, tries alternate buttons at 45s and reloads once at 75s; and
                  after the quiz completes, the extension returns to the course outline and opens the
                  next unfinished section automatically.
                </div>
              </details>
              <details>
                <summary>Where are the answers stored?<span className="x" /></summary>
                <div className="a">
                  In two places: a local database at <code>data/answers.json</code> (seeded with
                  1,721 questions, used for 0 ms hits) and the shared Convex cloud database that
                  every user contributes to. Browse either with <code>node answers.js</code>.
                </div>
              </details>
              <details>
                <summary>What happens if the AI cannot answer?<span className="x" /></summary>
                <div className="a">
                  The solver retries across all API keys and live models. If everything fails, it
                  submits a deterministic guess so the quiz keeps moving — configurable with
                  <code> ALLOW_FALLBACK_GUESS=false</code> in <code>.env</code>.
                </div>
              </details>
              <details>
                <summary>Can I use my friend&apos;s login?<span className="x" /></summary>
                <div className="a">
                  No. The account binds to the first device that signs in. A second device gets a
                  <code> device_mismatch</code> refusal. Only the owner can clear a binding with
                  <code> node admin.js reset-device</code>.
                </div>
              </details>
              <details>
                <summary>Does it still work if the relay is off?<span className="x" /></summary>
                <div className="a">
                  The extension idles safely and shows the relay as offline in its popup. Lesson
                  clicks stop, quiz pages stay untouched, and nothing breaks — turn the relay back on
                  and it resumes.
                </div>
              </details>
            </div>
          </Reveal>
        </div>
      </section>

      <footer>
        <div className="wrap">
          <div>
            ORACLE SOLVER 2026 · v2.0.0<br />
            relay 127.0.0.1:8787 · convex cloud · manifest v3
          </div>
          <div>
            <a href={DOWNLOAD} download>download extension</a>
          </div>
        </div>
        <div className="wrap">
          <p className="disclaimer">
            Educational project built for a final-year demonstration of browser automation, relay
            architecture, and cloud access control. Use of automated tools may violate Oracle
            Academy&apos;s terms of service; the authors take no responsibility for account action.
          </p>
        </div>
      </footer>
    </>
  );
}
