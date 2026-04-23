import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const PairPending = sequelize.define(
  "PairPending",
  {
    uplineUserId: { type: DataTypes.INTEGER, allowNull: false },
    side: { type: DataTypes.ENUM("LEFT", "RIGHT"), allowNull: false },
    downlineUserId: { type: DataTypes.INTEGER, allowNull: false },

    isUsed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    usedInPairMatchId: { type: DataTypes.INTEGER, allowNull: true },

      // ✅ NEW (for NO carry-forward)
    isFlushed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    flushedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    flushReason: { type: DataTypes.STRING(60), allowNull: true, defaultValue: null },
  },
  {
    indexes: [
      { fields: ["uplineUserId", "side", "isUsed"] },
      { fields: ["uplineUserId", "isFlushed"] },
      { fields: ["downlineUserId"] },
    ],
  }
);

export default PairPending;
