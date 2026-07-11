(function initFirebase() {
  if (!window.firebase || !window.NityHubConfig) {
    return;
  }

  if (!firebase.apps.length) {
    firebase.initializeApp(window.NityHubConfig.firebase);
  }

  window.NityHubFirebase = {
    auth: firebase.auth(),
    db: firebase.database()
  };
})();