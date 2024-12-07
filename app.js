// app.js

import express from "express";
import createError from "http-errors";
import path from "path";
import cookieParser from "cookie-parser";
import logger from "morgan";
import session from "express-session";
import passport from "passport";
import SteamStrategy from "passport-steam";
import { fileURLToPath } from "url";
import { neon } from "@neondatabase/serverless";

import indexRouter from "./routes/index.js";
import authRouter from "./routes/auth.js";
import groupRouter from "./routes/group.js"; 

const sql = neon("postgresql://gamenest_owner:2vdbTsro7fYp@ep-noisy-firefly-a5i6652r.us-east-2.aws.neon.tech/gamenest?sslmode=require");

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(
  session({
    secret: "incrediblepassword",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }, 
  })
);

passport.use(
  new SteamStrategy(
    {
      returnURL: "http://localhost:5500/auth/steam/return",
      realm: "http://localhost:5500/",
      apiKey: "7D015CE6D54B9B33854A408D92E3BCE1",
    },
    async (identifier, profile, done) => {
      try {
        const { steamid, personaname, loccountrycode } = profile._json;

        await sql(
          `INSERT INTO Jugador (id_usuario, nombre_usuario, pais)
           VALUES ($1, $2, $3)
           ON CONFLICT (id_usuario)
           DO UPDATE SET nombre_usuario = $2, pais = $3`,
          [steamid, personaname, loccountrycode]
        );

        return done(null, profile);
      } catch (error) {
        console.error("Error al guardar el usuario:", error);
        return done(error);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.use(logger("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(passport.initialize());
app.use(passport.session());

app.use(express.static(path.join(__dirname, "public")));

app.use("/", indexRouter);
app.use("/auth", authRouter);
app.use("/group", groupRouter); 

app.get("/user/profile", (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ success: true, profile: req.user });
  } else {
    res.json({ success: false, error: "No autenticado" });
  }
});

app.get("/user/pending-invitations", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ success: false, error: "No autenticado" });
  }

  const userId = req.user._json.steamid;

  try {
    const invitations = await sql(
      `SELECT SIGU.id_grupo, GF.nombre_grupo
       FROM SolicitudIngresoGrupoUsuario SIGU
       JOIN GrupoFamiliar GF ON SIGU.id_grupo = GF.id_grupo
       WHERE SIGU.id_usuario = $1 AND SIGU.estado_solicitud = 'pendiente'`,
      [userId]
    );

    res.json({ success: true, invitations });
  } catch (error) {
    console.error("Error al obtener invitaciones pendientes:", error);
    res.status(500).json({ success: false, error: "Error al obtener invitaciones pendientes." });
  }
});

app.use((req, res, next) => {
  next(createError(404));
});

app.use((err, req, res, next) => {
  res.locals.message = err.message;
  res.locals.error = req.app.get("env") === "development" ? err : {};

  res.status(err.status || 500);
  res.json({ error: err.message });
});

export default app;
