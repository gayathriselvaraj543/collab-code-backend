const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const axios = require("axios");
const mongoose = require("mongoose");
const authRoutes = require("./routes/auth");
const Room = require("./models/Room");
const app = express();
app.use(cors({
  origin: "https://collab-code-frontend-alpha.vercel.app",
  methods: ["GET", "POST"],
  credentials: true,
}));
app.use(express.json());
require("dotenv").config();
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 10000,
      heartbeatFrequencyMS: 2000,
      maxPoolSize: 10,
      retryWrites: true,
      retryReads: true
    });
    console.log('✅ Connected to MongoDB successfully');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    setTimeout(connectDB, 5000);
  }
};


connectDB();

mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err);
  setTimeout(connectDB, 5000);
});

mongoose.connection.on('disconnected', () => {
  console.log('MongoDB disconnected. Attempting to reconnect...');
  setTimeout(connectDB, 5000);
});

app.use('/api/auth', authRoutes);

app.use((req, res, next) => {
  console.log(`📥 [${new Date().toISOString()}] ${req.method} ${req.url}`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Request body:', req.body);
  }
  next();
});

app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(500).json({ message: 'Internal server error', error: err.message });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const activeUsers = {};        
const roomCode = {};         

app.post("/run-code", async (req, res) => {
  const { language, code } = req.body;

  const languageMap = {
    javascript: 63, 
    python: 71,     
    java: 62,      
    cpp: 54,       
  };

  const languageId = languageMap[language];

  if (!languageId) {
    return res.status(400).json({ error: "Unsupported language" });
  }

  try {
   
    const submission = await axios.post(
      "https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=false",
      {
        source_code: code,
        language_id: languageId,
        stdin: "",
      },
      {
        headers: {
  "Content-Type": "application/json",
  "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com",
  "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
}

      }
    );

    const token = submission.data.token;

    let result;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000)); 

      try {
        const resCheck = await axios.get(
          `https://judge0-ce.p.rapidapi.com/submissions/${token}?base64_encoded=false`,
          {
           headers: {
  "Content-Type": "application/json",
  "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com",
  "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
},

          }
        );

        result = resCheck.data;

       
        if (result.status.id >= 3) break;
      } catch (err) {
        console.error("Error polling Judge0 result:", err.message);
      }
    }

    if (!result) {
      return res.status(500).json({ error: "Failed to get execution result" });
    }

    if (result.stderr) {
      return res.json({ output: result.stderr });
    } else if (result.compile_output) {
      return res.json({ output: result.compile_output });
    } else {
      return res.json({ output: result.stdout || "No output" });
    }
  } catch (err) {
    console.error("Execution failed:", err.message);
    return res.status(500).json({ error: "Execution failed", details: err.message });
  }
});

io.on("connection", (socket) => {
  console.log("⚡ New client connected: " + socket.id);

  socket.on("create-room", async (roomId) => {
    try {

      const room = new Room({ roomId });
      await room.save();
      console.log(`✅ Room created: ${roomId}`);
    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit("error-message", "Failed to create room");
    }
  });

  socket.on("join-room", async ({ roomId, username }) => {
    try {

      const room = await Room.findOne({ roomId });
      if (!room) {
        socket.emit("error-message", "Room doesn't exist. Please create it first.");
        return;
      }

      socket.join(roomId);

      if (!activeUsers[roomId]) activeUsers[roomId] = [];

      activeUsers[roomId] = activeUsers[roomId].filter((u) => u.id !== socket.id);

      const existingUser = room.users.find(u => u.username === username);
      let finalUsername = username;
      
      if (!existingUser) {
    
        const isDuplicate = room.users.some(u => u.username.startsWith(username));
        if (isDuplicate) {
          finalUsername = `${username}_${Math.floor(Math.random() * 1000)}`;
        }
       
        room.users.push({
          username: finalUsername,
          lastSeen: new Date()
        });
      } else {
       
        existingUser.lastSeen = new Date();
        room.markModified('users');
      }

    
      activeUsers[roomId].push({ id: socket.id, username: finalUsername });
      await room.save();

      if (!roomCode[roomId] && room.code.size > 0) {
        roomCode[roomId] = {};
        for (const [lang, code] of room.code.entries()) {
          roomCode[roomId][lang] = code;
        }
      }

      if (roomCode[roomId]) {
        for (const lang in roomCode[roomId]) {
          socket.emit("code-update", {
            language: lang,
            code: roomCode[roomId][lang],
          });
        }
      }

      io.to(roomId).emit("user-list", {
        activeUsers: activeUsers[roomId],
        allUsers: room.users
      });

      socket.emit("room-joined-success");

      console.log(`📥 ${finalUsername} joined room ${roomId}`);
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit("error-message", "Failed to join room");
    }
  });

  socket.on("code-change", async ({ roomId, language, code }) => {
    try {
      if (!roomCode[roomId]) {
        roomCode[roomId] = {};
      }

      roomCode[roomId][language] = code;

      await Room.findOneAndUpdate(
        { roomId },
        { 
          $set: { [`code.${language}`]: code },
          lastActive: new Date()
        }
      );

      socket.to(roomId).emit("code-update", {
        language,
        code,
      });
    } catch (error) {
      console.error('Error saving code:', error);
    }
  });

  socket.on("disconnect", async () => {
    try {
      for (const roomId in activeUsers) {
        const disconnectedUser = activeUsers[roomId].find(u => u.id === socket.id);
       
        activeUsers[roomId] = activeUsers[roomId].filter(
          (user) => user.id !== socket.id
        );

        if (disconnectedUser) {
          const room = await Room.findOne({ roomId });
          if (room) {
            const user = room.users.find(u => u.username === disconnectedUser.username);
            if (user) {
              user.lastSeen = new Date();
              room.markModified('users');
              await room.save();
            }

            // Send updated user lists
            io.to(roomId).emit("user-list", {
              activeUsers: activeUsers[roomId],
              allUsers: room.users
            });
          }
        }
      }
      console.log("🚪 Client disconnected: " + socket.id);
    } catch (error) {
      console.error('Error updating room on disconnect:', error);
    }
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
app.get('/', (req, res) => {
  res.send('🚀 Backend is working!');
});
