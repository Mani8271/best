const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db.js");

const AdminUpiDetail = sequelize.define(
  "AdminUpiDetail",
  {
    upiId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    payeeName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    qrCode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  { timestamps: true }
);

module.exports = AdminUpiDetail;
