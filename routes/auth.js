import express from "express";
import passport from "passport";

const router = express.Router();

router.get("/steam", passport.authenticate("steam"));

router.get(
  "/steam/return",
  passport.authenticate("steam", { failureRedirect: "/" }),
  (req, res) => {
    res.redirect("/");
  }
);

router.get("/logout", (req, res) => {
  req.logout(err => {
    if (err) return next(err);
    res.redirect("/");
  });
});

export default router;
