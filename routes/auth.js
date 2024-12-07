import express from "express";
import passport from "passport";

const router = express.Router();

// Ruta para iniciar sesión con Steam
router.get("/steam", passport.authenticate("steam"));

// Callback después del inicio de sesión
router.get(
  "/steam/return",
  passport.authenticate("steam", { failureRedirect: "/" }),
  (req, res) => {
    res.redirect("/");
  }
);

// Ruta para cerrar sesión
router.get("/logout", (req, res) => {
  req.logout(err => {
    if (err) return next(err);
    res.redirect("/");
  });
});

export default router;
