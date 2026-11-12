/* Android Chrome / home-screen shortcuts already inset the page, so the
   env() safe-area values double-count and leave an empty band below the
   status bar and above the system navigation bar. iOS still needs them. */
if (/Android/i.test(navigator.userAgent)) {
  document.documentElement.style.setProperty('--safe-t', '0px');
  document.documentElement.style.setProperty('--safe-b', '0px');
}
