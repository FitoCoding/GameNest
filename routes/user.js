import express from "express";
import { neon } from "@neondatabase/serverless";

const sql = neon("postgresql://gamenest_owner:2vdbTsro7fYp@ep-noisy-firefly-a5i6652r.us-east-2.aws.neon.tech/gamenest?sslmode=require");
const router = express.Router();

router.get("/profile", (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ success: false, message: "No autenticado" });
  }
  res.json({ success: true, profile: req.user });
});

export default router;
