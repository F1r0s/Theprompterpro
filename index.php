<?php
$error = '';
$success = '';
$has_access = isset($_COOKIE['promptenhance_access']) && $_COOKIE['promptenhance_access'] === '1';

if (isset($_GET['reset_access'])) {
  setcookie('promptenhance_access', '', [
    'expires' => time() - 3600,
    'path' => '/',
    'secure' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
    'httponly' => true,
    'samesite' => 'Lax',
  ]);
  unset($_COOKIE['promptenhance_access']);
  $has_access = false;
}

if ($has_access && $_SERVER['REQUEST_METHOD'] !== 'POST') {
  header('Location: /index.html');
  exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['contact'])) {
  $contact = trim($_POST['contact']);
  $file = 'leads.txt';

  $is_email = filter_var($contact, FILTER_VALIDATE_EMAIL);
  $is_phone = preg_match('/^\d{7,15}$/', $contact);

  if ($is_email || $is_phone) {
    $data = $contact . PHP_EOL;

    if (file_put_contents($file, $data, FILE_APPEND | LOCK_EX) === false) {
      $error = "Unable to save your subscription right now.";
    } else {
      setcookie('promptenhance_access', '1', [
        'expires' => time() + (180 * 24 * 60 * 60),
        'path' => '/',
        'secure' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
        'httponly' => true,
        'samesite' => 'Lax',
      ]);
      header('Location: /index.html');
      exit;
    }
  } else {
    $error = "Please enter a valid email address or digits-only phone number.";
  }
}
?>


<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PromptEnhance | Subscribe to Newsletter</title>
  <link rel="icon" href="favicon.png">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: "Poppins", Arial, sans-serif;
      background: var(--c-bg, #faf5ee);
      color: var(--c-text, #3a302a);
      margin: 0;
      padding: 0;
      min-height: 100vh;
    }
    .page-shell {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background:
        radial-gradient(circle at top left, rgba(194, 101, 42, 0.07), transparent 30%),
        radial-gradient(circle at bottom right, rgba(79, 70, 229, 0.05), transparent 26%);
    }
    .container {
      width: 90%;
      max-width: 560px;
      padding: 36px 28px;
      background: rgba(255, 255, 255, 0.82);
      border-radius: 18px;
      border: 1px solid rgba(194, 101, 42, 0.18);
      box-shadow: 0 10px 30px rgba(58, 48, 42, 0.08);
      text-align: center;
      backdrop-filter: blur(12px);
      animation: fadeIn 1s ease;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    h1 {
      font-size: 2rem;
      line-height: 1.3;
      color: var(--c-text, #3a302a);
      margin-bottom: 1rem;
    }
    p {
      line-height: 1.6;
      margin-bottom: 1.5rem;
      font-size: 1rem;
      color: var(--c-text-sec, #78706a);
    }
    .highlight {
      color: var(--c-primary, #c2652a);
      font-weight: 600;
    }
    form {
      margin-top: 22px;
    }
    input[type="text"] {
      width: 100%;
      padding: 15px;
      border-radius: 10px;
      border: 1px solid rgba(216, 208, 200, 0.95);
      margin-bottom: 20px;
      font-size: 1em;
      text-align: center;
      outline: none;
      background: #fff;
      color: var(--c-text, #3a302a);
    }
    input[type="text"]::placeholder { color: rgba(58, 48, 42, 0.45); }
    button {
      background: linear-gradient(135deg, var(--c-primary, #c2652a), #d17a44);
      color: #fff;
      font-weight: 600;
      padding: 15px 40px;
      border: none;
      border-radius: 10px;
      font-size: 1.1em;
      cursor: pointer;
      transition: 0.3s ease;
    }
    button:hover {
      transform: translateY(-2px) scale(1.03);
      box-shadow: 0 8px 18px rgba(194, 101, 42, 0.28);
    }
    .message {
      margin-bottom: 15px;
      padding: 12px 14px;
      border-radius: 10px;
      font-size: 0.95em;
      line-height: 1.5;
    }
    .error {
      background: rgba(194, 101, 42, 0.1);
      border: 1px solid rgba(194, 101, 42, 0.35);
      color: var(--c-text, #3a302a);
    }
    .success {
      background: rgba(79, 70, 229, 0.08);
      border: 1px solid rgba(79, 70, 229, 0.2);
      color: var(--c-text, #3a302a);
    }
    .site-shell {
      display: flex;
      flex-direction: column;
      gap: 18px;
      align-items: center;
    }
    .hero-note {
      max-width: 42ch;
      margin: 0 auto;
    }
    .site-access {
      width: 100%;
      display: grid;
      gap: 14px;
    }
    .access-card {
      border-radius: 14px;
      padding: 18px 16px;
      background: rgba(255, 255, 255, 0.8);
      border: 1px solid rgba(216, 208, 200, 0.8);
      color: var(--c-text, #3a302a);
    }
    .brand-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 14px;
      border-radius: 999px;
      background: rgba(194, 101, 42, 0.12);
      border: 1px solid rgba(194, 101, 42, 0.28);
      color: var(--c-text, #3a302a);
      font-size: 0.86rem;
      letter-spacing: 0.02em;
    }
    .footer {
      margin-top: 30px;
      font-size: 0.85em;
      color: rgba(58, 48, 42, 0.62);
      line-height: 1.5;
    }
    @media (max-width: 600px) {
      .page-shell { padding: 16px; }
      .container { padding: 28px 18px; margin: 0; width: 100%; }
      h1 { font-size: 1.6rem; }
      button { width: 100%; padding: 15px; }
    }
  </style>
</head>
<body>
  <div class="page-shell">
    <div class="container">
      <div class="brand-chip">PromptEnhance</div>
      <h1>Subscribe to the PromptEnhance Newsletter</h1>

      <p>Enter your email address or a digits-only phone number to join our list.</p>

      <?php if (!empty($error)): ?>
        <div class="message error"><?= htmlspecialchars($error) ?></div>
      <?php endif; ?>

      <form method="POST">
        <input type="text" name="contact" placeholder="Enter your email or phone number" required>
        <button type="submit">Subscribe to newsletter</button>
      </form>

      <p class="footer">We respect your privacy. Unsubscribe anytime.</p>
    </div>
  </div>
</body>
</html>
