import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const Referral = sequelize.define(
  "Referral",
  {
    sponsorId: { type: DataTypes.INTEGER, allowNull: false },
    referredUserId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    position: { type: DataTypes.ENUM("LEFT", "RIGHT"), allowNull: false },
    joinBonusPaid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    timestamps: true,
    indexes: [
      { fields: ["sponsorId"] }
    ]
  }
);

export default Referral;
