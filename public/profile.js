(function () {
  var PHOTO_KEY = 'dashboardProfilePhoto';
  var AVATAR_SIZE = 160;

  var input = document.getElementById('profilePhotoInput');
  if (!input) return;

  function renderPhoto(dataUrl) {
    var html = dataUrl ? '<img src="' + dataUrl + '" alt="Profile photo" />' : 'SK';
    document.querySelectorAll('.wf-avatar').forEach(function (el) {
      el.innerHTML = html;
    });
  }

  var saved = localStorage.getItem(PHOTO_KEY);
  if (saved) renderPhoto(saved);

  // Every avatar on the page (topbar, drawer, Profile page) opens the same
  // upload flow - not just the topbar one.
  document.querySelectorAll('.wf-avatar').forEach(function (el) {
    el.addEventListener('click', function () {
      input.click();
    });
  });

  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    input.value = '';
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        var ctx = canvas.getContext('2d');
        var scale = Math.max(AVATAR_SIZE / img.width, AVATAR_SIZE / img.height);
        var w = img.width * scale;
        var h = img.height * scale;
        ctx.drawImage(img, (AVATAR_SIZE - w) / 2, (AVATAR_SIZE - h) / 2, w, h);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        try {
          localStorage.setItem(PHOTO_KEY, dataUrl);
        } catch (err) {
          // Storage full/unavailable - photo still shows for this page view.
        }
        renderPhoto(dataUrl);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
})();
