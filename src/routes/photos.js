const path = require('path');
const express = require('express');

// Serves uploaded inventory photos to signed-in staff only.
module.exports = function photoRoutes(db, { uploadDir }) {
  const router = express.Router();
  const selectPhoto = db.prepare('SELECT filename, mime_type FROM photos WHERE id = ?');

  router.get('/:id', (req, res) => {
    const photo = selectPhoto.get(Number(req.params.id));
    if (!photo) return res.status(404).end();
    res.type(photo.mime_type);
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.join(uploadDir, photo.filename), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  return router;
};
