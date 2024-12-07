// group.js

import express from "express";
import { neon } from "@neondatabase/serverless";
import fetch from "node-fetch";

const sql = neon("postgresql://gamenest_owner:2vdbTsro7fYp@ep-noisy-firefly-a5i6652r.us-east-2.aws.neon.tech/gamenest?sslmode=require");
const router = express.Router();

// Función auxiliar para obtener detalles completos del juego desde la API de Steam
const fetchGameDetails = async (appid) => {
  try {
    const response = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=spanish`);
    const data = await response.json();
    const gameData = data[appid]?.data;

    if (!gameData) {
      return {
        nombre_juego: 'Desconocido',
        desarrollador: 'Desconocido',
        genero: 'Desconocido',
        plataforma: 'Desconocido',
      };
    }

    // Obtener desarrollador
    const desarrollador = gameData.developers ? gameData.developers.join(', ') : 'Desconocido';

    // Obtener género
    const generos = gameData.genres ? gameData.genres.map(g => g.description) : [];
    const genero = generos.length > 0 ? generos.join(', ') : 'Desconocido';

    // Obtener plataformas
    const plataformas = [];
    if (gameData.platforms) {
      if (gameData.platforms.windows) plataformas.push('Windows');
      if (gameData.platforms.mac) plataformas.push('Mac');
      if (gameData.platforms.linux) plataformas.push('Linux');
    }
    const plataforma = plataformas.length > 0 ? plataformas.join(', ') : 'Desconocido';

    return {
      nombre_juego: gameData.name || 'Desconocido',
      desarrollador: desarrollador.substring(0, 100),
      genero: genero.substring(0, 50),
      plataforma: plataforma.substring(0, 50),
    };
  } catch (error) {
    console.error(`Error al obtener detalles del juego con appid ${appid}:`, error);
    return {
      nombre_juego: 'Desconocido',
      desarrollador: 'Desconocido',
      genero: 'Desconocido',
      plataforma: 'Desconocido',
    };
  }
};

// Obtener el grupo familiar del usuario
router.get("/my-group", async (req, res) => {
  const userId = req.user._json.steamid;

  try {
    const group = await sql(
      `SELECT * FROM GrupoFamiliar 
       WHERE id_admin_grupo = $1 OR id_grupo IN (
         SELECT id_grupo FROM MiembroGrupo WHERE id_usuario = $1
       )`,
      [userId]
    );

    if (group.length === 0) {
      return res.json({ success: false, message: "No tienes un grupo familiar." });
    }

    const groupId = group[0].id_grupo;

    const members = await sql(
      `SELECT J.id_usuario, J.nombre_usuario, MG.rol
       FROM MiembroGrupo MG
       JOIN Jugador J ON MG.id_usuario = J.id_usuario
       WHERE MG.id_grupo = $1`,
      [groupId]
    );

    const games = await sql(
      `SELECT J.id_juego, J.nombre_juego, GJ.cantidad_copias
       FROM JuegosEnGrupo GJ
       JOIN Juego J ON GJ.id_juego = J.id_juego
       WHERE GJ.id_grupo = $1`,
      [groupId]
    );

    const interests = await sql(
      `SELECT I.id_interes, J.nombre_juego 
       FROM Interes I
       JOIN Juego J ON I.id_juego = J.id_juego
       WHERE I.id_grupo = $1`,
      [groupId]
    );

    // Nuevo código para obtener solicitudes de ingreso pendientes (si el usuario es admin)
    let joinRequests = [];
    if (group[0].id_admin_grupo === userId) {
      joinRequests = await sql(
        `SELECT SI.id_solicitud, J.id_usuario, J.nombre_usuario, SI.fecha_solicitud
         FROM SolicitudIngreso SI
         JOIN Jugador J ON SI.id_usuario = J.id_usuario
         WHERE SI.id_grupo = $1 AND SI.estado_solicitud = 'pendiente'`,
        [groupId]
      );
    }

    res.json({ 
      success: true, 
      group: group[0], 
      members, 
      games, 
      interests, 
      isAdmin: group[0].id_admin_grupo === userId,
      joinRequests // Incluimos las solicitudes en la respuesta
    });
  } catch (error) {
    console.error("Error al obtener grupo familiar:", error);
    res.status(500).json({ error: "Error al obtener grupo familiar." });
  }
});

// Crear grupo y agregar juegos automáticamente
router.post("/create", async (req, res) => {
  const { nombreGrupo } = req.body;
  const userId = req.user._json.steamid;

  try {
    if (!nombreGrupo || nombreGrupo.trim() === "") {
      return res.status(400).json({ error: "El nombre del grupo no puede estar vacío." });
    }

    const existingGroup = await sql(
      `SELECT * FROM GrupoFamiliar WHERE id_admin_grupo = $1`,
      [userId]
    );

    if (existingGroup.length > 0) {
      return res.status(400).json({ error: "Ya tienes un grupo familiar." });
    }

    const groupResult = await sql(
      `INSERT INTO GrupoFamiliar (nombre_grupo, id_admin_grupo, pais, fecha_creacion)
       VALUES ($1, $2, $3, CURRENT_DATE)
       RETURNING id_grupo, nombre_grupo`,
      [nombreGrupo, userId, req.user._json.loccountrycode]
    );

    const groupId = groupResult[0].id_grupo;

    await sql(
      `INSERT INTO MiembroGrupo (id_usuario, id_grupo, fecha_ingreso, rol)
       VALUES ($1, $2, CURRENT_DATE, 'admin')`,
      [userId, groupId]
    );

    // Obtener juegos del usuario y agregarlos al grupo y a BibliotecaUsuario
    const response = await fetch(
      `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=7D015CE6D54B9B33854A408D92E3BCE1&steamid=${userId}&include_appinfo=true`
    );
    const data = await response.json();

    if (data.response.games) {
      for (const game of data.response.games) {
        const { appid, name } = game;

        // Verificar si el juego ya existe en la tabla Juego
        const juegoExiste = await sql(
          `SELECT 1 FROM Juego WHERE id_juego = $1`,
          [appid]
        );

        if (juegoExiste.length === 0) {
          const { desarrollador, genero, plataforma } = await fetchGameDetails(appid);
          await sql(
            `INSERT INTO Juego (id_juego, nombre_juego, desarrollador, genero, plataforma)
             VALUES ($1, $2, $3, $4, $5)`,
            [appid, name, desarrollador, genero, plataforma]
          );
        }

        // Agregar a BibliotecaUsuario
        await sql(
          `INSERT INTO BibliotecaUsuario (id_juego, id_usuario, fecha_adicion)
           VALUES ($1, $2, CURRENT_DATE)
           ON CONFLICT DO NOTHING`,
          [appid, userId]
        );

        // Verificar si el juego ya existe en JuegosEnGrupo
        const juegoEnGrupoExiste = await sql(
          `SELECT * FROM JuegosEnGrupo WHERE id_grupo = $1 AND id_juego = $2`,
          [groupId, appid]
        );

        if (juegoEnGrupoExiste.length > 0) {
          // Si existe, incrementar cantidad_copias en 1
          await sql(
            `UPDATE JuegosEnGrupo
             SET cantidad_copias = cantidad_copias + 1, fecha_actualizacion = CURRENT_DATE
             WHERE id_grupo = $1 AND id_juego = $2`,
            [groupId, appid]
          );
        } else {
          // Si no existe, insertar en JuegosEnGrupo con cantidad_copias = 1
          await sql(
            `INSERT INTO JuegosEnGrupo (id_grupo, id_juego, cantidad_copias, fecha_actualizacion)
             VALUES ($1, $2, 1, CURRENT_DATE)`,
            [groupId, appid]
          );
        }
      }
    }

    res.json({ success: true, groupId, groupName: groupResult[0].nombre_grupo });
  } catch (error) {
    console.error("Error al crear el grupo:", error);
    res.status(500).json({ error: "Error al crear el grupo familiar." });
  }
});

// Agregar wishlist del usuario como intereses al grupo
router.post("/add-wishlist-to-group", async (req, res) => {
  const { groupId } = req.body;
  const userId = req.user._json.steamid;

  if (!groupId) {
    return res.status(400).json({ error: "El ID del grupo es requerido." });
  }

  try {
    // Verificar si el grupo existe y el usuario es miembro/admin
    const group = await sql(
      `SELECT * FROM GrupoFamiliar 
       WHERE id_grupo = $1 
         AND (id_admin_grupo = $2 OR id_grupo IN (
           SELECT id_grupo FROM MiembroGrupo WHERE id_usuario = $2
         ))`,
      [groupId, userId]
    );

    if (group.length === 0) {
      return res.status(404).json({ error: "Grupo no encontrado o no tienes permisos." });
    }

    // Obtener la wishlist del usuario
    console.log(`Solicitando wishlist para SteamID: ${userId}`);
    const wishlistResponse = await fetch(
      `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?key=7D015CE6D54B9B33854A408D92E3BCE1&steamid=${userId}`
    );

    if (!wishlistResponse.ok) {
      console.error(`Error en la solicitud de wishlist: ${wishlistResponse.status} ${wishlistResponse.statusText}`);
      return res.status(500).json({ error: "Error al obtener la wishlist." });
    }

    const wishlist = await wishlistResponse.json();
    console.log("Respuesta de la wishlist:", JSON.stringify(wishlist, null, 2));

    // Verificar la estructura de la respuesta
    if (wishlist && wishlist.response && Array.isArray(wishlist.response.items)) {
      // Iterar sobre cada item en la wishlist
      for (const item of wishlist.response.items) {
        const appid = item.appid;
        const priority = item.priority; // Asumiendo que 'priority' es de la wishlist

        try {
          console.log(`Obteniendo detalles del juego AppID: ${appid}`);
          const gameDetails = await fetchGameDetails(appid);
          if (!gameDetails) {
            console.error(`No se pudieron obtener detalles para el juego ${appid}. Saltando.`);
            continue;
          }

          const { nombre_juego, desarrollador, genero, plataforma } = gameDetails;

          // Verificar si el juego ya existe en la tabla Juego
          const juegoExiste = await sql(
            `SELECT 1 FROM Juego WHERE id_juego = $1`,
            [appid]
          );

          if (juegoExiste.length === 0) {
            // Insertar el juego en la tabla Juego
            try {
              await sql(
                `INSERT INTO Juego (id_juego, nombre_juego, desarrollador, genero, plataforma)
                 VALUES ($1, $2, $3, $4, $5)`,
                [appid, nombre_juego, desarrollador, genero, plataforma]
              );
              console.log(`Juego insertado en la base de datos: ${appid}`);
            } catch (dbError) {
              console.error(`Error al insertar juego ${appid} en la base de datos:`, dbError);
              continue; // Saltar este juego y continuar con el siguiente
            }
          }

          // Obtener el género del juego desde la tabla Juego
          const juego = await sql(
            `SELECT genero FROM Juego WHERE id_juego = $1`,
            [appid]
          );
          const juegoGenero = juego.length > 0 ? juego[0].genero : 'Desconocido';

          // Verificar si el interés ya existe
          const interesExiste = await sql(
            `SELECT 1 FROM Interes WHERE id_grupo = $1 AND id_juego = $2 AND id_usuario = $3`,
            [groupId, appid, userId]
          );

          if (interesExiste.length === 0) {
            // Insertar en Interes
            try {
              await sql(
                `INSERT INTO Interes (id_grupo, id_juego, id_usuario, genero, prioridad, fecha_registro)
                 VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)`,
                [groupId, appid, userId, juegoGenero, priority]
              );
              console.log(`Interés insertado para el juego ${appid} en el grupo ${groupId}`);
            } catch (dbError) {
              console.error(`Error al insertar interés para el juego ${appid}:`, dbError);
              continue; // Saltar este interés y continuar
            }
          }
        } catch (error) {
          console.error(`Error al procesar el juego AppID ${appid}:`, error);
          continue; // Saltar este juego y continuar
        }
      }

      res.json({ success: true, message: "Wishlist agregada como intereses al grupo." });
    } else {
      console.warn("La wishlist está vacía o no se pudo obtener correctamente.");
      return res.status(404).json({ error: "No se pudo obtener la wishlist o está vacía." });
    }
  } catch (error) {
    console.error("Error al agregar wishlist como intereses:", error);
    res.status(500).json({ error: "Error al agregar wishlist como intereses." });
  }
});

// Eliminar interés del grupo (solo para administradores)
router.delete("/interest/:id", async (req, res) => {
  const userId = req.user._json.steamid;
  const interestId = req.params.id;

  try {
    // Obtener el interés y el grupo al que pertenece
    const interest = await sql(
      `SELECT I.id_grupo
       FROM Interes I
       WHERE I.id_interes = $1`,
      [interestId]
    );

    if (interest.length === 0) {
      return res.status(404).json({ error: "El interés no existe." });
    }

    const groupId = interest[0].id_grupo;

    // Verificar si el usuario es administrador del grupo
    const group = await sql(
      `SELECT id_admin_grupo
       FROM GrupoFamiliar
       WHERE id_grupo = $1`,
      [groupId]
    );

    if (group.length === 0 || group[0].id_admin_grupo !== userId) {
      return res.status(403).json({ error: "No tienes permisos para eliminar este interés." });
    }

    // Eliminar el interés
    await sql(
      `DELETE FROM Interes
       WHERE id_interes = $1`,
      [interestId]
    );

    res.json({ success: true, message: "Interés eliminado correctamente." });
  } catch (error) {
    console.error("Error al eliminar interés:", error);
    res.status(500).json({ error: "Error al eliminar el interés." });
  }
});

// Editar nombre del grupo
router.put("/edit", async (req, res) => {
  const { newName } = req.body;
  const userId = req.user._json.steamid;

  try {
    if (!newName || newName.trim() === "") {
      return res.status(400).json({ error: "El nuevo nombre no puede estar vacío." });
    }

    const result = await sql(
      `UPDATE GrupoFamiliar
       SET nombre_grupo = $1
       WHERE id_admin_grupo = $2
       RETURNING nombre_grupo`,
      [newName, userId]
    );

    if (result.length === 0) {
      return res.status(404).json({ error: "No se encontró el grupo o no tienes permisos." });
    }

    res.json({ success: true, newName: result[0].nombre_grupo });
  } catch (error) {
    console.error("Error al editar el grupo:", error);
    res.status(500).json({ error: "Error al editar el grupo familiar." });
  }
});

// Eliminar grupo familiar
router.delete("/delete", async (req, res) => {
  const userId = req.user._json.steamid;

  try {
    const group = await sql(
      `SELECT id_grupo FROM GrupoFamiliar WHERE id_admin_grupo = $1`,
      [userId]
    );

    if (group.length === 0) {
      return res.status(404).json({ error: "No se encontró tu grupo familiar." });
    }

    const groupId = group[0].id_grupo;

    // Eliminar solicitudes de ingreso relacionadas con el grupo
    await sql(
      `DELETE FROM SolicitudIngreso WHERE id_grupo = $1`,
      [groupId]
    );

    // Eliminar juegos del grupo
    await sql(
      `DELETE FROM JuegosEnGrupo WHERE id_grupo = $1`,
      [groupId]
    );

    // Eliminar miembros del grupo
    await sql(
      `DELETE FROM MiembroGrupo WHERE id_grupo = $1`,
      [groupId]
    );

    // Eliminar intereses del grupo
    await sql(
      `DELETE FROM Interes WHERE id_grupo = $1`,
      [groupId]
    );

    // Eliminar el grupo
    await sql(
      `DELETE FROM GrupoFamiliar WHERE id_grupo = $1`,
      [groupId]
    );

    res.json({ success: true, message: "Grupo familiar eliminado correctamente." });
  } catch (error) {
    console.error("Error al eliminar grupo:", error);
    res.status(500).json({ error: "Error al eliminar grupo familiar." });
  }
});

// Buscar grupos familiares
router.get("/search", async (req, res) => {
  const { query } = req.query;

  try {
    const groups = await sql(
      `SELECT * FROM GrupoFamiliar
       WHERE nombre_grupo ILIKE $1
       LIMIT 10`,
      [`%${query}%`]
    );

    res.json({ success: true, groups });
  } catch (error) {
    console.error("Error al buscar grupos:", error);
    res.status(500).json({ error: "Error al buscar grupos familiares." });
  }
});

// Eliminar miembro del grupo (solo para administradores)
router.delete("/member/:id", async (req, res) => {
  const userId = req.user._json.steamid;
  const memberId = req.params.id;

  try {
    // Verificar si el usuario es administrador
    const group = await sql(
      `SELECT id_grupo FROM GrupoFamiliar WHERE id_admin_grupo = $1`,
      [userId]
    );

    if (group.length === 0) {
      return res.status(403).json({ error: "No tienes permisos para eliminar miembros." });
    }

    const groupId = group[0].id_grupo;

    // No permitir que el administrador se elimine a sí mismo
    if (memberId == userId) {
      return res.status(400).json({ error: "No puedes eliminarte a ti mismo del grupo." });
    }

    // Verificar que el miembro pertenece al grupo
    const member = await sql(
      `SELECT * FROM MiembroGrupo WHERE id_usuario = $1 AND id_grupo = $2`,
      [memberId, groupId]
    );

    if (member.length === 0) {
      return res.status(404).json({ error: "El miembro no pertenece al grupo." });
    }

    // Obtener los juegos del usuario en BibliotecaUsuario
    const userGames = await sql(
      `SELECT id_juego FROM BibliotecaUsuario WHERE id_usuario = $1`,
      [memberId]
    );

    // Ajustar JuegosEnGrupo reduciendo la cantidad de copias o eliminando el juego si corresponde
    for (const game of userGames) {
      const appid = game.id_juego;

      // Reducir cantidad_copias en JuegosEnGrupo
      await sql(
        `UPDATE JuegosEnGrupo
         SET cantidad_copias = cantidad_copias - 1
         WHERE id_grupo = $1 AND id_juego = $2`,
        [groupId, appid]
      );

      // Eliminar el juego de JuegosEnGrupo si cantidad_copias es 0
      await sql(
        `DELETE FROM JuegosEnGrupo
         WHERE id_grupo = $1 AND id_juego = $2 AND cantidad_copias <= 0`,
        [groupId, appid]
      );
    }

    // Eliminar juegos del usuario de BibliotecaUsuario
    await sql(
      `DELETE FROM BibliotecaUsuario WHERE id_usuario = $1`,
      [memberId]
    );

    // Eliminar miembro del grupo
    await sql(
      `DELETE FROM MiembroGrupo WHERE id_usuario = $1 AND id_grupo = $2`,
      [memberId, groupId]
    );

    res.json({ success: true, message: "Miembro eliminado correctamente." });
  } catch (error) {
    console.error("Error al eliminar miembro:", error);
    res.status(500).json({ error: "Error al eliminar miembro del grupo." });
  }
});

// Dejar el grupo (para miembros que no son administradores)
router.post("/leave", async (req, res) => {
  const userId = req.user._json.steamid;

  try {
    // Verificar si el usuario pertenece a un grupo
    const membership = await sql(
      `SELECT * FROM MiembroGrupo WHERE id_usuario = $1`,
      [userId]
    );

    if (membership.length === 0) {
      return res.status(400).json({ error: "No perteneces a ningún grupo." });
    }

    const groupId = membership[0].id_grupo;

    // Verificar si el usuario es administrador
    const group = await sql(
      `SELECT id_admin_grupo FROM GrupoFamiliar WHERE id_grupo = $1`,
      [groupId]
    );

    if (group[0].id_admin_grupo === userId) {
      return res.status(400).json({ error: "El administrador no puede dejar el grupo. Debe eliminar el grupo o transferir la administración." });
    }

    // Obtener los juegos del usuario en BibliotecaUsuario
    const userGames = await sql(
      `SELECT id_juego FROM BibliotecaUsuario WHERE id_usuario = $1`,
      [userId]
    );

    // Ajustar JuegosEnGrupo reduciendo la cantidad de copias o eliminando el juego si corresponde
    for (const game of userGames) {
      const appid = game.id_juego;

      // Reducir cantidad_copias en JuegosEnGrupo
      await sql(
        `UPDATE JuegosEnGrupo
         SET cantidad_copias = cantidad_copias - 1
         WHERE id_grupo = $1 AND id_juego = $2`,
        [groupId, appid]
      );

      // Eliminar el juego de JuegosEnGrupo si cantidad_copias es 0
      await sql(
        `DELETE FROM JuegosEnGrupo
         WHERE id_grupo = $1 AND id_juego = $2 AND cantidad_copias <= 0`,
        [groupId, appid]
      );
    }

    // Eliminar juegos del usuario de BibliotecaUsuario
    await sql(
      `DELETE FROM BibliotecaUsuario WHERE id_usuario = $1`,
      [userId]
    );

    // Eliminar miembro del grupo
    await sql(
      `DELETE FROM MiembroGrupo WHERE id_usuario = $1 AND id_grupo = $2`,
      [userId, groupId]
    );

    res.json({ success: true, message: "Has salido del grupo correctamente." });
  } catch (error) {
    console.error("Error al salir del grupo:", error);
    res.status(500).json({ error: "Error al salir del grupo." });
  }
});

// Cambiar rol de un miembro (solo para administradores)
router.post("/change-role", async (req, res) => {
  const userId = req.user._json.steamid;
  const { memberId, newRole } = req.body;

  try {
    // Verificar si el usuario es administrador
    const group = await sql(
      `SELECT id_grupo, id_admin_grupo FROM GrupoFamiliar WHERE id_admin_grupo = $1`,
      [userId]
    );

    if (group.length === 0) {
      return res.status(403).json({ error: "No tienes permisos para cambiar roles." });
    }

    const groupId = group[0].id_grupo;

    // Verificar que el miembro pertenece al grupo
    const member = await sql(
      `SELECT * FROM MiembroGrupo WHERE id_usuario = $1 AND id_grupo = $2`,
      [memberId, groupId]
    );

    if (member.length === 0) {
      return res.status(404).json({ error: "El miembro no pertenece al grupo." });
    }

    if (newRole === 'admin') {
      // Actualizar id_admin_grupo en GrupoFamiliar
      await sql(
        `UPDATE GrupoFamiliar SET id_admin_grupo = $1 WHERE id_grupo = $2`,
        [memberId, groupId]
      );

      // Actualizar rol del antiguo admin a 'miembro'
      await sql(
        `UPDATE MiembroGrupo SET rol = 'miembro' WHERE id_usuario = $1 AND id_grupo = $2`,
        [userId, groupId]
      );
    }

    // Actualizar rol del miembro
    await sql(
      `UPDATE MiembroGrupo SET rol = $1 WHERE id_usuario = $2 AND id_grupo = $3`,
      [newRole, memberId, groupId]
    );

    res.json({ success: true, message: "Rol actualizado correctamente." });
  } catch (error) {
    console.error("Error al cambiar rol:", error);
    res.status(500).json({ error: "Error al cambiar rol del miembro." });
  }
});

// Obtener grupos recomendados
router.get("/recommendations", async (req, res) => {
  const userId = req.user._json.steamid;

  try {
    // Obtener wishlist del usuario
    const wishlistResponse = await fetch(
      `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?key=7D015CE6D54B9B33854A408D92E3BCE1&steamid=${userId}`
    );
    const wishlistData = await wishlistResponse.json();

    let wishlistAppIds = [];
    if (wishlistData.response && wishlistData.response.items) {
      wishlistAppIds = wishlistData.response.items.map(item => item.appid);
    }

    // Limpiar intereses existentes del usuario
    await sql(
      `DELETE FROM InteresesUsuario WHERE id_usuario = $1`,
      [userId]
    );

    // Guardar wishlist en InteresesUsuario
    for (const appid of wishlistAppIds) {
      // Verificar si el juego ya existe en la tabla Juego
      const juegoExiste = await sql(
        `SELECT 1 FROM Juego WHERE id_juego = $1`,
        [appid]
      );

      if (juegoExiste.length === 0) {
        const { desarrollador, genero, plataforma } = await fetchGameDetails(appid);
        await sql(
          `INSERT INTO Juego (id_juego, nombre_juego, desarrollador, genero, plataforma)
           VALUES ($1, $2, $3, $4, $5)`,
          [appid, 'Desconocido', desarrollador, genero, plataforma] // Nombre del juego no disponible en esta respuesta
        );
      }

      // Insertar en InteresesUsuario evitando duplicados
      await sql(
        `INSERT INTO InteresesUsuario (id_usuario, id_juego)
         VALUES ($1, $2)
         ON CONFLICT (id_juego, id_usuario) DO NOTHING`,
        [userId, appid]
      );
    }

    // Obtener grupos junto con el número de juegos coincidentes
    const groups = await sql(
      `SELECT GF.id_grupo, GF.nombre_grupo, GF.pais,
              COUNT(DISTINCT JG.id_juego) AS total_juegos,
              COUNT(DISTINCT IU.id_juego) AS matches
       FROM GrupoFamiliar GF
       LEFT JOIN JuegosEnGrupo JG ON GF.id_grupo = JG.id_grupo
       LEFT JOIN InteresesUsuario IU ON JG.id_juego = IU.id_juego AND IU.id_usuario = $1
       GROUP BY GF.id_grupo
       ORDER BY matches DESC`,
      [userId]
    );

    res.json({ success: true, groups });

  } catch (error) {
    console.error("Error al obtener grupos recomendados:", error);
    res.status(500).json({ error: "Error al obtener grupos recomendados." });
  }
});

// Solicitar unirse a un grupo
router.post("/request-join", async (req, res) => {
  const userId = req.user._json.steamid;
  const { groupId } = req.body;

  try {
    // Verificar si el usuario ya pertenece a un grupo
    const existingGroup = await sql(
      `SELECT * FROM MiembroGrupo WHERE id_usuario = $1`,
      [userId]
    );

    if (existingGroup.length > 0) {
      return res.status(400).json({ error: "Ya perteneces a un grupo familiar." });
    }

    // Verificar si ya existe una solicitud pendiente para este grupo
    const existingRequest = await sql(
      `SELECT * FROM SolicitudIngreso
       WHERE id_usuario = $1 AND id_grupo = $2 AND estado_solicitud = 'pendiente'`,
      [userId, groupId]
    );

    if (existingRequest.length > 0) {
      return res.status(400).json({ error: "Ya has solicitado unirte a este grupo. Por favor espera a que el administrador responda." });
    }

    // Crear solicitud de ingreso
    await sql(
      `INSERT INTO SolicitudIngreso (id_usuario, id_grupo, estado_solicitud, fecha_solicitud)
       VALUES ($1, $2, 'pendiente', CURRENT_DATE)`,
      [userId, groupId]
    );

    res.json({ success: true, message: "Solicitud enviada al administrador del grupo." });
  } catch (error) {
    console.error("Error al solicitar unirse al grupo:", error);
    res.status(500).json({ error: "Error al solicitar unirse al grupo." });
  }
});

// Responder a una solicitud de ingreso (aceptar o rechazar)
router.post("/respond-request", async (req, res) => {
  const userId = req.user._json.steamid;
  const { solicitudId, respuesta } = req.body;

  try {
    // Verificar que la respuesta sea válida
    if (!['aceptada', 'rechazada'].includes(respuesta)) {
      return res.status(400).json({ error: "Respuesta inválida." });
    }

    // Obtener la solicitud
    const solicitud = await sql(
      `SELECT * FROM SolicitudIngreso WHERE id_solicitud = $1 AND estado_solicitud = 'pendiente'`,
      [solicitudId]
    );

    if (solicitud.length === 0) {
      return res.status(404).json({ error: "La solicitud no existe o ya fue respondida." });
    }

    const groupId = solicitud[0].id_grupo;

    // Verificar si el usuario es administrador del grupo
    const group = await sql(
      `SELECT id_admin_grupo FROM GrupoFamiliar WHERE id_grupo = $1`,
      [groupId]
    );

    if (group.length === 0 || group[0].id_admin_grupo !== userId) {
      return res.status(403).json({ error: "No tienes permisos para responder esta solicitud." });
    }

    // Actualizar el estado de la solicitud
    await sql(
      `UPDATE SolicitudIngreso
       SET estado_solicitud = $1
       WHERE id_solicitud = $2`,
      [respuesta, solicitudId]
    );

    if (respuesta === 'aceptada') {
      const solicitanteId = solicitud[0].id_usuario;

      // Agregar al usuario como miembro del grupo
      await sql(
        `INSERT INTO MiembroGrupo (id_usuario, id_grupo, fecha_ingreso, rol)
         VALUES ($1, $2, CURRENT_DATE, 'miembro')`,
        [solicitanteId, groupId]
      );

      // **Agregar los juegos del usuario al grupo y a BibliotecaUsuario**
      const response = await fetch(
        `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=7D015CE6D54B9B33854A408D92E3BCE1&steamid=${solicitanteId}&include_appinfo=true`
      );
      const data = await response.json();

      if (data.response.games) {
        for (const game of data.response.games) {
          const { appid, name } = game;

          // Verificar si el juego ya existe en la tabla Juego
          const juegoExiste = await sql(
            `SELECT 1 FROM Juego WHERE id_juego = $1`,
            [appid]
          );

          if (juegoExiste.length === 0) {
            const { desarrollador, genero, plataforma } = await fetchGameDetails(appid);
            await sql(
              `INSERT INTO Juego (id_juego, nombre_juego, desarrollador, genero, plataforma)
               VALUES ($1, $2, $3, $4, $5)`,
              [appid, name, desarrollador, genero, plataforma]
            );
          }

          // Agregar a BibliotecaUsuario
          await sql(
            `INSERT INTO BibliotecaUsuario (id_juego, id_usuario, fecha_adicion)
             VALUES ($1, $2, CURRENT_DATE)
             ON CONFLICT DO NOTHING`,
            [appid, solicitanteId]
          );

          // Verificar si el juego ya está en JuegosEnGrupo para este grupo
          const existingGameInGroup = await sql(
            `SELECT * FROM JuegosEnGrupo WHERE id_grupo = $1 AND id_juego = $2`,
            [groupId, appid]
          );

          if (existingGameInGroup.length > 0) {
            // Si existe, incrementar cantidad_copias en 1
            await sql(
              `UPDATE JuegosEnGrupo
               SET cantidad_copias = cantidad_copias + 1, fecha_actualizacion = CURRENT_DATE
               WHERE id_grupo = $1 AND id_juego = $2`,
              [groupId, appid]
            );
          } else {
            // Si no existe, insertar en JuegosEnGrupo con cantidad_copias = 1
            await sql(
              `INSERT INTO JuegosEnGrupo (id_grupo, id_juego, cantidad_copias, fecha_actualizacion)
               VALUES ($1, $2, 1, CURRENT_DATE)`,
              [groupId, appid]
            );
          }
        }
      }
    }

    res.json({ success: true, message: `Solicitud ${respuesta} correctamente.` });
  } catch (error) {
    console.error("Error al responder solicitud:", error);
    res.status(500).json({ error: "Error al responder la solicitud." });
  }
});

// Encontrar jugadores para el grupo
router.get("/find-players-for-group", async (req, res) => {
  const { groupId } = req.query;
  const userId = req.user._json.steamid; // ID del usuario actual

  // Validar si se ha proporcionado el ID del grupo
  if (!groupId) {
    return res.status(400).json({ error: "El ID del grupo es requerido." });
  }

  try {
    // Buscar jugadores con coincidencias de juegos en común con el grupo
    const playersWithMatches = await sql(
      `SELECT 
         J.id_usuario, 
         J.nombre_usuario, 
         COUNT(BU.id_juego) AS coincidencias
       FROM Jugador J
       LEFT JOIN BibliotecaUsuario BU ON J.id_usuario = BU.id_usuario
       WHERE J.id_usuario != $1 -- Excluir al usuario actual
         AND J.id_usuario NOT IN (SELECT id_usuario FROM MiembroGrupo) -- Excluir usuarios que ya están en un grupo
         AND BU.id_juego IN (
           SELECT id_juego
           FROM Interes
           WHERE id_grupo = $2
         )
       GROUP BY J.id_usuario, J.nombre_usuario
       ORDER BY coincidencias DESC
       LIMIT 10`,
      [userId, groupId]
    );

    // Si no se han encontrado 10 jugadores, buscar más sin coincidencias de juegos
    if (playersWithMatches.length < 10) {
      const additionalPlayers = await sql(
        `SELECT 
           J.id_usuario, 
           J.nombre_usuario, 
           0 AS coincidencias
         FROM Jugador J
         WHERE J.id_usuario != $1
           AND J.id_usuario NOT IN (SELECT id_usuario FROM MiembroGrupo)
           AND J.id_usuario NOT IN (
             SELECT id_usuario 
             FROM BibliotecaUsuario 
             WHERE id_juego IN (
               SELECT id_juego 
               FROM Interes 
               WHERE id_grupo = $2
             )
           )
         LIMIT $3`,
        [userId, groupId, 10 - playersWithMatches.length]
      );

      // Agregar los jugadores adicionales al array de resultados
      playersWithMatches.push(...additionalPlayers);
    }

    // Responder con la lista de jugadores
    return res.json({ success: true, players: playersWithMatches });
  } catch (error) {
    console.error("Error al buscar jugadores para el grupo:", error);
    res.status(500).json({ success: false, message: "Error al buscar jugadores para el grupo." });
  }
});

// Gestionar solicitudes de unión
router.post("/request-join-group", async (req, res) => {
  const { groupId, userId } = req.body;

  if (!groupId || !userId) {
    return res.status(400).json({ error: "El ID del grupo y del usuario son requeridos." });
  }

  try {
    // Registrar la solicitud en la base de datos
    await sql(
      `INSERT INTO SolicitudIngresoGrupoUsuario (id_usuario, id_grupo, estado_solicitud, fecha_solicitud)
       VALUES ($1, $2, 'pendiente', CURRENT_DATE)
       ON CONFLICT (id_usuario, id_grupo) DO NOTHING`,
      [userId, groupId]
    );

    // Notificar al administrador del grupo
    const adminInfo = await sql(
      `SELECT id_admin_grupo 
       FROM GrupoFamiliar 
       WHERE id_grupo = $1`,
      [groupId]
    );

    if (adminInfo.length > 0) {
      const adminId = adminInfo[0].id_admin_grupo;
      // Aquí podrías integrar un sistema de notificaciones real
      console.log(`Notificación: Usuario ${userId} solicitó unirse al grupo ${groupId}, notificar a admin ${adminId}.`);
    }

    res.json({ success: true, message: "Solicitud enviada correctamente." });
  } catch (error) {
    console.error("Error al enviar la solicitud:", error);
    res.status(500).json({ success: false, message: "Error al enviar la solicitud." });
  }
});

// Aceptar invitación al grupo
router.post("/accept-invitation", async (req, res) => {
  const userId = req.user._json.steamid; // Usuario actual
  const { groupId } = req.body;

  if (!groupId) {
    return res.status(400).json({ error: "El ID del grupo es requerido." });
  }

  try {
    // Verificar que la invitación exista y esté pendiente
    const invitation = await sql(
      `SELECT * FROM SolicitudIngresoGrupoUsuario 
       WHERE id_usuario = $1 AND id_grupo = $2 AND estado_solicitud = 'pendiente'`,
      [userId, groupId]
    );

    if (invitation.length === 0) {
      return res.status(404).json({ error: "No tienes invitaciones pendientes para este grupo." });
    }

    // Marcar la invitación como aceptada
    await sql(
      `UPDATE SolicitudIngresoGrupoUsuario 
       SET estado_solicitud = 'aceptada'
       WHERE id_usuario = $1 AND id_grupo = $2`,
      [userId, groupId]
    );

    // Agregar al usuario como miembro del grupo
    await sql(
      `INSERT INTO MiembroGrupo (id_usuario, id_grupo, fecha_ingreso, rol)
       VALUES ($1, $2, CURRENT_DATE, 'miembro')`,
      [userId, groupId]
    );

    // Agregar los juegos del usuario al grupo
    const userGames = await sql(
      `SELECT id_juego FROM BibliotecaUsuario WHERE id_usuario = $1`,
      [userId]
    );

    for (const game of userGames) {
      const appid = game.id_juego;

      const existingGame = await sql(
        `SELECT * FROM JuegosEnGrupo WHERE id_grupo = $1 AND id_juego = $2`,
        [groupId, appid]
      );

      if (existingGame.length > 0) {
        // Incrementar cantidad de copias
        await sql(
          `UPDATE JuegosEnGrupo
           SET cantidad_copias = cantidad_copias + 1, fecha_actualizacion = CURRENT_DATE
           WHERE id_grupo = $1 AND id_juego = $2`,
          [groupId, appid]
        );
      } else {
        // Insertar nuevo juego en el grupo
        await sql(
          `INSERT INTO JuegosEnGrupo (id_grupo, id_juego, cantidad_copias, fecha_actualizacion)
           VALUES ($1, $2, 1, CURRENT_DATE)`,
          [groupId, appid]
        );
      }
    }

    res.json({ success: true, message: "Has aceptado la invitación y ahora eres miembro del grupo." });
  } catch (error) {
    console.error("Error al aceptar la invitación:", error);
    res.status(500).json({ error: "Error al aceptar la invitación." });
  }
});

export default router;
