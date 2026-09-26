var currentUser = null;

function hideOverlay() {
  var overlay = document.getElementById('globalOverlayLoader');
  if (overlay) overlay.classList.add('hidden');
}

function showOverlay(msg) {
  var overlay = document.getElementById('globalOverlayLoader');
  if (overlay) {
    document.getElementById('overlayText').innerText = msg || 'Loading...';
    overlay.classList.remove('hidden');
  }
}

async function checkAuth(activeNavId) {
  try {
    var res = await fetch('/api/me');
    if (res.ok) {
      currentUser = await res.json();
      setupHeader(activeNavId);
      return currentUser;
    } else {
      window.location.href = '/login';
    }
  } catch (err) {
    window.location.href = '/login';
  }
}

function setupHeader(activeNavId) {
  var userInfoSpan = document.getElementById('userInfo');
  if (userInfoSpan) {
    userInfoSpan.innerText = currentUser.username + ' (' + currentUser.role + ')';
  }

  if (currentUser.role === 'ADMIN') {
    var adminBtn = document.getElementById('adminNavBtn');
    if (adminBtn) adminBtn.classList.remove('hidden');
  } else if (currentUser.role === 'SUPERADMIN') {
    var adminBtn = document.getElementById('adminNavBtn');
    var superadminBtn = document.getElementById('superadminNavBtn');
    if (adminBtn) adminBtn.classList.remove('hidden');
    if (superadminBtn) superadminBtn.classList.remove('hidden');
  }

  if (activeNavId) {
    var activeBtn = document.getElementById(activeNavId);
    if (activeBtn) activeBtn.classList.add('active');
  }
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
}