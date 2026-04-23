import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const ReferralEdge = sequelize.define(
  "ReferralEdge",
  {
    sponsorId: { type: DataTypes.INTEGER, allowNull: false },
    childId: { type: DataTypes.INTEGER, allowNull: false, unique: true },

    position: { type: DataTypes.ENUM("LEFT", "RIGHT"), allowNull: false },
    slot: { type: DataTypes.INTEGER, allowNull: false }, // 1..n
  },
  { timestamps: true }
);

export default ReferralEdge;
