const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
    roomId: {
        type: String,
        required: true,
        unique: true
    },
    users: [{
        username: String,
        lastSeen: Date
    }],
    code: {
        type: Map,
        of: String,
        default: {}  
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastActive: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Room', roomSchema);
