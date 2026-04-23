import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const DeliveryCharge = sequelize.define(
  "DeliveryCharge",
  {
    minAmount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },

    maxAmount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true, // null = no upper limit
    },

    charge: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },

    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  },
  { timestamps: true }
);

export default DeliveryCharge;
